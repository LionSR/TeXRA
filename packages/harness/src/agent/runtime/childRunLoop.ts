import { randomUUID } from 'node:crypto';
import { Cause, Clock, Effect, Exit, type Fiber, type Semaphore } from 'effect';

// Shared child accounting and durable delivery for native runs and processes.

import type { AgentTrace, StageHandle } from '@agent/trace/AgentTrace';
import type { TraceEmitter } from '@agent/trace/TraceEmitter';
import {
  endActivation,
  endVerdict,
  type EndVerdict,
} from '@agent/runtime/AgentRunLifecycle';
import { Inbox, followUpServices } from '@agent/followUp/ToolUseFollowUp';
import type { FollowUpServices } from '@agent/followUp/ToolUseFollowUp';
import { resolveChildRunConcurrencyBudget } from '@agent/runtime/childRunBudget';
import {
  registryOf,
  type RunRegistry,
  type AgentRunServices,
  Runs,
} from '@agent/runtime/runRegistry';
import type { RunInput } from '@agent/followUp/RunInput';
import {
  childTurnResult,
  commitPart,
  deliverIn,
  partServices,
  sendToParent,
  traceLog,
  turnResultPart,
  wakeParent,
  type ChildTurnResult,
  type TransactionPart,
  type TurnResultRow,
} from '@agent/runtime/childTurnResult';
import { pauseChildRun } from '@agent/runtime/delegation/childRun';
import { classifyAgentError } from '@common/errors/agentErrorClassification';
import { SessionRoots } from '@platform/rootedFs';
import {
  RUN_OUTCOME,
  qualifyAggregateId,
  type FollowUpContent,
  type ResultMeta,
  type RunId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import {
  DatabaseNotOwner,
  type DatabaseWriteFailed,
} from '@shared/session/database';
import { SessionLog } from '@shared/session/runHistory';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { Alongside } from '@shared/session/sessionEvents';
import { aggregateError } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

/** A stopped child's pause: the notice its parent reads, and the id a
 *  tool call names to continue it (a Codex thread, a Claude session), which
 *  the `child.park` row keeps so that call reactivates this same run. */
export interface ChildRunPause {
  readonly text: string;
  readonly resumeId?: string;
}

/** A process child's trace (agent CLI, background bash), whose end is its
 *  loop's; a native run's trace is its own, and it has no port. */
export interface ChildRunPort {
  readonly logger: TraceEmitter;
}

/**
 * A native run's child policy: each turn runs under `turnPermit` (a child
 * waiting for input holds no slot) and its result commits in the batch that
 * ends it (its boundary's `waiting` row, or the last turn's `run.end`). `R`:
 * the services they read of the run that calls them, its loop and its end.
 */
export interface ChildRunTurns<TTurn, R> extends ChildRunBoundary<TTurn, R> {
  /** Finish the run's last turn: what its `run.end` transaction writes. A
   *  failure here is the loop's, raised once the run is joined. */
  finishLastTurn(
    turn: TTurn,
  ): Effect.Effect<TransactionPart | undefined, never, R>;
}

/** What a native run's loop takes of its child policy. */
export interface ChildRunBoundary<TTurn, R> {
  turnPermit<A, E, RTurn>(
    turn: Effect.Effect<A, E, RTurn>,
  ): Effect.Effect<A, E | Error, R | RTurn>;
  /** Finish a turn the run goes on from: rows for its boundary batch, the
   *  parent's delivery written in that batch's transaction, and the parent's
   *  resume to run once the batch commits ({@link wakeParent}). */
  finishTurn(turn: TTurn): Effect.Effect<
    {
      readonly rows: readonly TurnResultRow[];
      readonly alongside: Alongside<Error> | undefined;
      readonly wakeParent: Effect.Effect<void, Error>;
    },
    Error,
    R
  >;
}

/** What every child strategy says of its turns; `R` names the services a
 *  turn reads, forwarded to the loop's caller. */
export interface ChildStrategyBase<TTurn, R> {
  /** Stage label opened on the child trace (e.g. "Codex session"). */
  readonly stageLabel: string;
  /** A turn that did not throw but reports an error (an SDK error result). */
  isTurnError?(turn: TTurn): boolean;
  /** The error message to log for a non-throwing failure, if it has one. */
  turnErrorMessage?(turn: TTurn): string | undefined;
  /** The success delivery XML: an Effect over `R`, since a recipe-run
   *  subagent writes its diff files on the way. */
  formatDelivery(
    turn: TTurn,
    wallTimeMs: number,
  ): Effect.Effect<string, Error, R>;
  /** The error delivery XML (turn is null when the call threw). */
  formatError(turn: TTurn | null, err: unknown, wallTimeMs: number): string;
  /** The result manifest persisted beside each turn's report, success or
   *  failure (`turn` null when the call threw), so a failure overwrites a
   *  stale interim one. */
  buildResultMeta?(
    turn: TTurn | null,
    isError: boolean,
    wallTimeMs: number,
  ): Effect.Effect<ResultMeta | undefined, Error, R>;
}

/** A native run's strategy: its program is the child's one turn, owns its
 *  input wait, and offers each turn boundary through `turns`. */
export interface NativeChildStrategy<
  TTurn,
  R = never,
> extends ChildStrategyBase<TTurn, R> {
  /** `notify` is an awaiting caller's live progress; a background child
   *  reports none. A child reports no spend: its priced calls are rows on
   *  its own run, summed over the run tree. Its run calls `turns` within
   *  this effect, under the services it runs with. */
  launch(
    notify: ((update: SubagentProgressUpdate) => void) | undefined,
    turns: ChildRunTurns<TTurn, R | FollowUpServices>,
  ): Effect.Effect<TTurn, Error, R>;
  /** An interrupted turn has no new result to record. */
  isTurnInterrupted(turn: TTurn): boolean;
  /** A script run reports once, under one delivery id (a resumed script's
   *  delivery is a replay), and stopped by a user tells its parent what it
   *  had done; a subagent delivers each turn under its own id, tells nothing. */
  readonly script?: {
    readonly deliveryId: string;
    stopNotice(): Effect.Effect<string, Error, R>;
  };
}

/** An external process's strategy (agent CLI, background bash): each turn's
 *  result commits in the loop, which then waits for the child's next batch:
 *  a one-turn command whose killed process still has a result, or a coding
 *  agent's CLI session (`cli`), a turn per batch of follow-ups. */
export type ProcessChildStrategy<TTurn, R = never> = ChildStrategyBase<
  TTurn,
  R
> & {
  /** A stop interrupts the turn's fiber: a foreign call takes its signal
   *  from that interruption (`Effect.abortSignal`, `Effect.tryPromise`). */
  launch(): Effect.Effect<TTurn, Error, R>;
} & (
    | {
        /** The turn a stop cut short, rebuilt from what the child buffered
         *  and delivered: a killed OS process's exit code and output. */
        interruptedTurn(): TTurn;
        readonly cli?: undefined;
      }
    | {
        readonly cli: {
          /** The next turn, from the queued follow-ups. */
          runTurn(
            followUps: readonly FollowUpContent[],
          ): Effect.Effect<TTurn, Error, R>;
          /** What the paused child had done and how the parent's model
           *  continues it; undefined cancels it instead. */
          pauseNotice(): ChildRunPause | undefined;
          /** After a successful turn: register the session/thread id, etc. */
          onTurnSuccess(turn: TTurn): void;
          /** Release provider-owned registry entries; called once, before a
           *  failed or interrupted delivery or at the end. */
          releaseSessionOwnership(): void;
        };
        readonly interruptedTurn?: undefined;
      }
  );

/** The fields every child loop takes. */
interface ChildRunLoopShared {
  readonly parentRunId: RunId;
  /** The child's run: its input and its interrupt target. */
  readonly runId: RunId;
  readonly agentName: string;
  /** Where an awaiting caller shows the child's progress while it runs (its
   *  call's card). A background child's parent hears its turn results only. */
  readonly notify?: (update: SubagentProgressUpdate) => void;
}

/**
 * One child loop's parameters, by family: a native child (no port), in the
 * session's child-run budget unless `awaited` (its caller joins the loop and
 * reads its last turn: no slot, no delivery or notice to the parent, and a
 * cancelled turn is still its last), or a process child with its port.
 */
export type ChildRunLoopParams<TTurn, R = never> = ChildRunLoopShared &
  (
    | {
        readonly childRun?: undefined;
        readonly awaited?: true;
        readonly strategy: NativeChildStrategy<TTurn, R>;
      }
    | {
        readonly childRun: ChildRunPort;
        readonly strategy: ProcessChildStrategy<TTurn, R>;
      }
  );

/** What an awaiting caller reads of the turn a child ended with. */
interface LastTurn {
  readonly resultMeta: ResultMeta | undefined;
  readonly isError: boolean;
  /** What the turn threw, when it threw. */
  readonly error?: unknown;
}

/** A started child loop: its fiber, and the turn its end recorded, read
 *  once the fiber is done (undefined when no turn finished at its end). */
export interface StartedChildRunLoop<TTurn> {
  readonly fiber: Fiber.Fiber<TTurn | undefined, Error>;
  readonly lastTurn: () => LastTurn | undefined;
}

/** The child's last turn as its end writes it: still open (a stop, an
 *  interrupted turn); finished, with its result (`handedOff`: given to a
 *  native run's own `run.end`, before it commits); or a build failure, the
 *  loop's failure once the run is joined (its end is written without it). */
type ChildEnd =
  | { readonly kind: 'open' }
  | {
      readonly kind: 'finished';
      readonly result: ChildTurnResult;
      readonly turn: LastTurn;
      readonly handedOff: boolean;
    }
  | { readonly kind: 'error'; readonly error: Error };

/**
 * One child loop's state, passed through the functions below: its setup,
 * its turn, and `end`, its last turn's result. A stop is its run fiber's
 * interruption, its reason the registry activation's. The activation mints
 * its turn keys (`attemptId`, `turnIndex`), which the `child.turn` rows record.
 */
class ChildLoop<TTurn, R> {
  readonly attemptId = randomUUID();
  stage: StageHandle | undefined;
  budget: Semaphore.Semaphore | undefined;
  ownershipReleased = false;
  turnIndex = 0;
  turnStart = 0;
  /** The follow-ups the current turn's prompt took. */
  consumed: readonly QueuedFollowUp[] = [];
  /** A native child its caller joins and reads the last turn of. */
  get awaited(): boolean {
    return this.params.childRun === undefined && this.params.awaited === true;
  }
  /** Why the child failed; the cause may itself be `undefined`. */
  failure: { readonly cause: unknown } | undefined;
  end: ChildEnd = { kind: 'open' };

  readonly params: ChildRunLoopParams<TTurn, R>;
  readonly runs: RunRegistry;
  constructor(params: ChildRunLoopParams<TTurn, R>, runs: RunRegistry) {
    this.params = params;
    this.runs = runs;
  }

  get trace(): AgentTrace | undefined {
    return this.params.childRun?.logger;
  }

  /** The process strategy of a process child. */
  get process(): ProcessChildStrategy<TTurn, R> | undefined {
    const { params } = this;
    return params.childRun === undefined ? undefined : params.strategy;
  }

  /** Release provider-owned registry entries, once. */
  releaseOwnership(): void {
    if (this.ownershipReleased) return;
    this.ownershipReleased = true;
    this.process?.cli?.releaseSessionOwnership();
  }

  /** One loop diagnostic ({@link traceLog}). */
  log(
    level: Parameters<typeof traceLog>[2],
    message: string,
    data?: unknown,
  ): Effect.Effect<void> {
    return traceLog(this.trace, 'childRunLoop', level, message, data);
  }
}

/** A turn that ran to an outcome: its turn (null when it threw), the error
 *  it threw, and whether it reported a failure without throwing. */
interface Turned<TTurn> {
  readonly turn: TTurn | null;
  readonly err: unknown;
  readonly turnIsError: boolean;
}

/** Run one turn: its turn (null when it threw), its error, and its
 *  application-level error flag. A stop goes on as the turn's interruption,
 *  once a turn its strategy rebuilds from what it buffered is recorded as
 *  the last one, never a success. */
function attemptTurn<TTurn, R, RTurn>(
  loop: ChildLoop<TTurn, R>,
  run: Effect.Effect<TTurn, Error, RTurn>,
): Effect.Effect<Turned<TTurn>, Error, R | RTurn | SessionLog> {
  const { strategy } = loop.params;
  const startedAt = loop.turnStart;
  return Effect.gen(function* () {
    const attempt = yield* Effect.exit(
      Effect.gen(function* () {
        const turn = yield* run;
        // The turn summary on the child stream.
        const wallTimeMs = (yield* Clock.currentTimeMillis) - startedAt;
        yield* loop.log(
          'info',
          `Turn completed in ${(wallTimeMs / 1000).toFixed(1)}s`,
        );
        const turnIsError = strategy.isTurnError?.(turn) === true;
        const turnError = turnIsError
          ? strategy.turnErrorMessage?.(turn)
          : undefined;
        if (turnError) yield* loop.log('error', turnError);
        return { turn, err: null, turnIsError };
      }),
    );
    if (Exit.isSuccess(attempt)) return attempt.value;
    if (Cause.hasInterrupts(attempt.cause)) {
      const cutShort = loop.process?.interruptedTurn;
      if (cutShort) {
        const turned = { turn: cutShort(), err: null, turnIsError: true };
        const end = yield* Effect.uninterruptible(
          recordLastTurn(loop, turned, false),
        );
        if (end.kind === 'error') loop.failure ??= { cause: end.error };
      }
      return yield* Effect.failCause(attempt.cause);
    }
    const caught = Cause.squash(attempt.cause);
    yield* loop.log('error', toErrorMessage(caught));
    return { turn: null, err: caught, turnIsError: false };
  });
}

/** A turn that threw, or reported an error without throwing, fails the
 *  child, with the turn's own message when it carries one. */
const noteFailure = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  { turn, err, turnIsError }: Turned<TTurn>,
): void => {
  if (err == null && !turnIsError) return;
  const { strategy } = loop.params;
  const message =
    (turn !== null && strategy.turnErrorMessage?.(turn)) ||
    `${strategy.stageLabel} reported a failed turn without throwing.`;
  loop.failure = { cause: err ?? new Error(message) };
};

/** A process child's waiting row (`child.park`): `parked` before the loop
 *  waits on its input, `resumed` when a batch it took starts the next turn. */
const waitingRow = (runId: RunId, phase: 'parked' | 'resumed') =>
  ({
    type: 'child.park',
    aggregateId: qualifyAggregateId('run', runId),
    phase,
  }) as const;

/**
 * Accept the next turn: its `child.turn accepted` row, the fact the
 * report/result slots are attributed from, with the `resumed` row that ends
 * the wait. Not best-effort: a refused append is the turn's failure, and
 * `not-owner` stops the loop rather than run under a lost claim.
 */
const beginTurn = Effect.fn('childRunLoop.beginTurn')(function* <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  resumed: boolean,
): Effect.fn.Return<void, DatabaseNotOwner | DatabaseWriteFailed, SessionLog> {
  const { runId } = loop.params;
  loop.turnIndex += 1;
  loop.turnStart = yield* Clock.currentTimeMillis;
  yield* (yield* SessionLog).transact([
    ...(resumed ? [waitingRow(runId, 'resumed')] : []),
    {
      type: 'child.turn',
      aggregateId: qualifyAggregateId('run', runId),
      attemptId: loop.attemptId,
      turnIndex: loop.turnIndex,
      phase: 'accepted',
    },
  ]);
});

/** Who reads this turn's result: its parent, unless nothing awaits the
 *  child. A detach is read from the child's rows in the job delivering it
 *  (`deliverIn`). */
const deliveryTarget = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  isError: boolean,
): RunId | null => {
  const { params } = loop;
  const { parentRunId: target } = params;
  if (loop.awaited) return null;
  if (isError) loop.releaseOwnership();
  return target;
};

/** One turn's result, and what an awaiting caller reads of it. */
const buildTurnResult = Effect.fn('childRunLoop.buildTurnResult')(function* <
  TTurn,
  R,
>(
  loop: ChildLoop<TTurn, R>,
  { turn, err, turnIsError }: Turned<TTurn>,
  last = false,
) {
  const { params } = loop;
  const { strategy, runId } = params;
  if (loop.turnIndex === 0) {
    // A run that never entered the session has no rows to end under.
    if ((yield* (yield* SessionLog).facts(runId)) === null)
      return yield* Effect.fail(
        new Error('The run ended without entering the session.'),
      );
    yield* beginTurn(loop, false);
  }
  const wallTimeMs = (yield* Clock.currentTimeMillis) - loop.turnStart;
  const isError = err != null || turnIsError;
  const message =
    turn != null && !isError
      ? yield* strategy.formatDelivery(turn, wallTimeMs)
      : yield* Effect.try({
          try: () => strategy.formatError(turn, err, wallTimeMs),
          catch: ensureError,
        });
  const resultMeta = strategy.buildResultMeta
    ? yield* strategy.buildResultMeta(turn, isError, wallTimeMs)
    : undefined;
  const result = childTurnResult({
    runId,
    turn: { key: loop.attemptId, index: loop.turnIndex },
    message,
    resultMeta,
    consumed: loop.consumed,
    deliveryId:
      params.childRun === undefined
        ? params.strategy.script?.deliveryId
        : undefined,
    to: deliveryTarget(loop, isError),
    ...(last && { end: isError ? 'failed' : 'completed' }),
  });
  return {
    result,
    turn: { resultMeta, isError, ...(err != null && { error: err }) },
  };
});

/** Record the last turn as the child's end, which writes its result with
 *  its `run.end` (`handedOff`: a native run's own). A failure is the loop's,
 *  raised once the run is joined. */
const recordLastTurn = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  turned: Turned<TTurn>,
  handedOff: boolean,
): Effect.Effect<ChildEnd, never, R | SessionLog> =>
  buildTurnResult(loop, turned, true).pipe(
    Effect.map((built): ChildEnd => ({
      kind: 'finished',
      ...built,
      handedOff,
    })),
    Effect.catch((error) => Effect.succeed<ChildEnd>({ kind: 'error', error })),
    Effect.tap((end) => Effect.sync(() => (loop.end = end))),
  );

/** The last turn ends the child: recorded here unless a native run's own
 *  `run.end` took it; a result that could not be built is the loop's
 *  failure. */
const endTurns = Effect.fn('childRunLoop.endTurns')(function* <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  turned: Turned<TTurn>,
): Effect.fn.Return<void, Error, R | SessionLog> {
  const end =
    loop.end.kind === 'open'
      ? yield* recordLastTurn(loop, turned, false)
      : loop.end;
  if (end.kind === 'error') return yield* Effect.fail(end.error);
});

/** The turns a native run's own loop finishes, on its own fiber, under the
 *  services of the run that calls them. What a turn hands back to run later
 *  carries the caller's services, picked: the parent's delivery runs in the
 *  job committing the turn's batch, and holds the parent's claim for that
 *  job's scope alone. */
function nativeTurns<TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  strategy: NativeChildStrategy<TTurn, R>,
): ChildRunTurns<TTurn, R | FollowUpServices> {
  return {
    turnPermit: Effect.fn('childRunLoop.turnPermit')(function* (turn) {
      yield* beginTurn(loop, false);
      return yield* loop.budget ? loop.budget.withPermit(turn) : turn;
    }),
    finishTurn: Effect.fn('childRunLoop.finishTurn')(function* (turn) {
      const turned = { turn, err: null, turnIsError: false };
      const { rows, delivery } = (yield* buildTurnResult(loop, turned)).result;
      const parts = yield* partServices;
      const delivered = delivery && deliverIn(delivery, loop.trace);
      return {
        rows,
        alongside:
          delivered &&
          Effect.map(Effect.provide(delivered, parts), (part) => part.rows),
        wakeParent: Effect.provide(
          wakeParent(delivery, loop.trace),
          yield* followUpServices,
        ),
      };
    }),
    // The native run's own `run.end` commits these.
    finishLastTurn: Effect.fn('childRunLoop.finishLastTurn')(function* (turn) {
      if (!loop.awaited && strategy.isTurnInterrupted(turn)) return undefined;
      const turnIsError = strategy.isTurnError?.(turn) === true;
      const turned = { turn, err: null, turnIsError };
      const end = yield* recordLastTurn(loop, turned, true);
      return end.kind === 'finished'
        ? turnResultPart(end.result, loop.trace)
        : undefined;
    }),
  };
}

/**
 * A process child's interim turn, in one transaction: its result, its
 * parent's delivery and the `parked` row, durable before
 * the loop waits so a follow-up is accepted; then the ids it answers to
 * (so one sent on them finds it waiting, never mid-turn), and the parent's
 * resume.
 */
const finishInterimTurn = Effect.fn('childRunLoop.finishInterimTurn')(
  function* <TTurn, R>(
    loop: ChildLoop<TTurn, R>,
    turned: Turned<TTurn>,
  ): Effect.fn.Return<void, Error, R | AgentRunServices> {
    const { runId } = loop.params;
    const { result } = yield* buildTurnResult(loop, turned);
    yield* commitPart(
      turnResultPart(result, loop.trace, waitingRow(runId, 'parked')),
    );
    if (turned.turn !== null) loop.process?.cli?.onTurnSuccess(turned.turn);
    yield* wakeParent(result.delivery, loop.trace);
  },
);

/**
 * A native child: its launch runs the whole run on its own fiber and offers
 * its turn boundaries through `nativeTurns`; a launch that fails before its
 * run's birth tells the parent as input alone.
 */
const driveNative = Effect.fn('childRunLoop.driveNative')(function* <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  strategy: NativeChildStrategy<TTurn, R>,
): Effect.fn.Return<TTurn | undefined, Error, R | AgentRunServices> {
  const { runId } = loop.params;
  loop.turnStart = yield* Clock.currentTimeMillis;
  const turned = yield* attemptTurn(
    loop,
    Effect.suspend(() =>
      strategy.launch(loop.params.notify, nativeTurns(loop, strategy)),
    ),
  );
  const { turn } = turned;
  // A turn that reports itself stopped stops the child.
  if (turn !== null && !loop.awaited && strategy.isTurnInterrupted(turn))
    return yield* Effect.interrupt;
  noteFailure(loop, turned);
  // A launch that failed before its run's birth: there is no run to end,
  // and the launch waiting for the birth fails with it.
  if (
    loop.turnIndex === 0 &&
    loop.failure !== undefined &&
    !(yield* (yield* SessionLog).owns(runId))
  )
    return yield* Effect.fail(ensureError(loop.failure.cause));
  yield* endTurns(loop, turned);
  return turn ?? undefined;
});

/**
 * A process child: each turn's result commits here before the loop waits on
 * `input` for its next batch; a stop interrupts the turn or the wait.
 */
const driveProcess = Effect.fn('childRunLoop.driveProcess')(function* <
  TTurn,
  R,
>(
  loop: ChildLoop<TTurn, R>,
  strategy: ProcessChildStrategy<TTurn, R>,
  input: RunInput,
): Effect.fn.Return<TTurn | undefined, Error, R | AgentRunServices> {
  let next = () => strategy.launch();
  let result: TTurn | undefined;
  let resumed = false;
  for (;;) {
    yield* beginTurn(loop, resumed);
    const turned = yield* attemptTurn(loop, Effect.suspend(next));
    const { turn } = turned;
    if (turn !== null) result = turn;
    noteFailure(loop, turned);
    const { cli } = strategy;
    if (loop.failure !== undefined || turn === null || cli === undefined) {
      yield* endTurns(loop, turned);
      break;
    }
    yield* finishInterimTurn(loop, turned);
    const batch = yield* input.next('idle');
    if (!batch) break;
    // The batch ends the wait: the turn it starts is the current one.
    loop.consumed = batch.kind === 'synthetic' ? [] : batch.followUps;
    resumed = true;
    const prompts: readonly FollowUpContent[] =
      batch.kind === 'synthetic'
        ? [{ text: batch.text, from: { kind: 'user' } }]
        : loop.consumed.map((followUp) => followUp.content);
    next = () => cli.runTurn(prompts);
  }
  return result;
});

/** A user's stop of a native child queues what it left for its parent to
 *  resume; a notice that cannot be read still says the child stopped. The
 *  parent hears the end the store holds: a stop that lands after the run's
 *  own end leaves that end, and the delivery it carried, as told. */
const sendStopNotice = Effect.fn('childRunLoop.sendStopNotice')(function* <
  TTurn,
  R,
>(loop: ChildLoop<TTurn, R>, strategy: NativeChildStrategy<TTurn, R>) {
  const { runId, parentRunId } = loop.params;
  if (
    strategy.script === undefined ||
    loop.awaited ||
    loop.runs.stopCause(runId) !== 'user'
  )
    return;
  const held = (yield* (yield* SessionLog).facts(runId))?.end?.outcome;
  if (held !== undefined && held !== RUN_OUTCOME.CANCELLED) return;
  const text = yield* strategy.script
    .stopNotice()
    .pipe(
      Effect.catch((error) =>
        Effect.as(
          loop.log('warn', 'Child-run stop notice failed', { runId, error }),
          `Run ${runId} was stopped. What it had done could not be read: ${toErrorMessage(error)}`,
        ),
      ),
    );
  const deliveryId = `${runId}:${loop.attemptId}:stopped`;
  const item = { text, from: { kind: 'run', runId } as const, deliveryId };
  const hold = { hold: 'instruction' } as const;
  yield* sendToParent(item, parentRunId, hold, loop.trace);
});

/**
 * The child's end, carrying the last turn's result unless its run's end
 * took it: a stopped process child that can be continued pauses; a native
 * child whose own lifecycle ended it commits that result alone; any other
 * end is the activation's ({@link endActivation}), a native child's only
 * while it still holds the run.
 */
const writeEnd = Effect.fnUntraced(function* <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  verdict: EndVerdict,
): Effect.fn.Return<void, Error, R | AgentRunServices> {
  const { params } = loop;
  const { runId } = params;
  const { end } = loop;
  const { outcome, reason, error } = verdict;
  const lastTurn =
    end.kind === 'finished' && !end.handedOff
      ? turnResultPart(end.result, loop.trace)
      : undefined;
  // A `run.end` that never wrote fails the loop: its terminal fact is gone.
  const endRun = (ownerless: boolean) =>
    Effect.flatMap(
      endActivation({
        runId,
        ownerless,
        outcome,
        reason,
        ...(error != null && { error: classifyAgentError(error) }),
        stage: loop.stage,
        lastTurn: () => Effect.succeed(lastTurn),
      }),
      ({ persistFailure: cause }) =>
        cause === undefined
          ? Effect.void
          : Effect.fail(
              new Error(`Child run ${runId} terminal state was not persisted`, {
                cause,
              }),
            ),
    );
  if (params.childRun !== undefined) {
    const port = params.childRun;
    const pause =
      outcome === RUN_OUTCOME.CANCELLED
        ? params.strategy.cli?.pauseNotice()
        : undefined;
    if (
      pause &&
      (yield* pauseChildRun(runId, port, pause, lastTurn, loop.stage))
    )
      return;
    return yield* endRun(false).pipe(
      Effect.ensuring(Effect.sync(() => port.logger.close())),
    );
  }
  if (outcome !== RUN_OUTCOME.COMPLETED) {
    if (yield* (yield* SessionLog).owns(runId)) yield* endRun(true);
  } else if (lastTurn !== undefined) yield* commitPart(lastTurn);
  yield* sendStopNotice(loop, params.strategy);
});

/**
 * The loop's terminal (exit protocol): a stop lands before or after it, so
 * the terminal row, the provider ids and the stage are all handled on every
 * exit; the body's failure propagates as itself, joined by the cleanup's.
 * The parent is woken once the generation let the child's claim go
 * ({@link startChildRunLoop}).
 */
const endChildLoop = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  body: Exit.Exit<TTurn | undefined, Error>,
): Effect.Effect<void, Error, R | AgentRunServices> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const { failure } = loop;
      // A turn's failure fails a body that returned; a body that did not
      // return ends by its cause.
      const verdict = endVerdict(
        Exit.isSuccess(body) && failure !== undefined
          ? Exit.fail(failure.cause)
          : Exit.map(body, () => RUN_OUTCOME.COMPLETED),
        loop.runs.stopCause(loop.params.runId),
      );
      // Debug-only driver diagnostic: how the loop ended.
      yield* loop.log('debug', 'childRunLoop loop.terminated', {
        runId: loop.params.runId,
        outcome: verdict.outcome,
      });
      const terminal = yield* Effect.exit(writeEnd(loop, verdict));
      // Provider ids stay reserved until the terminal (or pause) row is
      // written, so a call naming one finds this run, not a gap.
      const owned = yield* Effect.exit(
        Effect.sync(() => loop.releaseOwnership()),
      );
      // A stage its end did not close.
      loop.stage?.end(RUN_OUTCOME.FAILED);
      const failures = [terminal, owned].flatMap((exit) =>
        Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : [],
      );
      if (failures.length > 0)
        return yield* Effect.fail(
          ensureError(aggregateError(failures, 'Child run and cleanup failed')),
        );
    }),
  );

/** The launched run, all on its fiber, whose generation holds the child's
 *  claim: its setup (the budget its turns take, its stage), a process
 *  child's reader, its turns, and its terminal on every exit. */
const runChildLoop = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
): Effect.Effect<TTurn | undefined, Error, R | AgentRunServices> =>
  Effect.gen(function* () {
    const { params } = loop;
    const { runId } = params;
    if (params.childRun === undefined && !loop.awaited)
      loop.budget = yield* loop.runs.childRunBudget(
        yield* resolveChildRunConcurrencyBudget(yield* SessionRoots),
      );
    loop.stage = loop.trace?.openStage(params.strategy.stageLabel);
    // A native child's own loop opens its reader, as any run's loop does.
    if (params.childRun === undefined)
      return yield* driveNative(loop, params.strategy);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const reader = yield* Inbox.use((inbox) => inbox.open(runId));
        // Its end is the child's: it takes no more input here.
        yield* Effect.addFinalizer(() =>
          Inbox.useSync((inbox) => inbox.release(runId, reader, true)),
        );
        return yield* driveProcess(loop, params.strategy, reader);
      }),
    );
  }).pipe(Effect.onExit((body) => endChildLoop(loop, body)));

/**
 * Own one child's delivery, queue, concurrency budget and terminal cleanup.
 * A native launch runs on its own fiber and offers its turn boundaries to
 * this loop; process strategies return a turn and wait for their next batch
 * here.
 */
export function startChildRunLoop<TTurn, R extends AgentRunServices = never>(
  params: ChildRunLoopParams<TTurn, R>,
): Effect.Effect<StartedChildRunLoop<TTurn>, Error, R | Runs> {
  return Effect.flatMap(Runs, (runs) => {
    const loop = new ChildLoop(params, registryOf(runs));
    // Admitted a tick later; a refused one still lets an agent CLI's
    // provider ids go. The parent may read this child at once: it is woken
    // once the generation let the child's claim go.
    const launched = loop.runs.start(
      params.runId,
      runChildLoop(loop),
      (admitted) =>
        Effect.andThen(Effect.yieldNow, admitted).pipe(
          Effect.ensuring(Effect.sync(() => loop.releaseOwnership())),
          Effect.onExit(() =>
            loop.end.kind === 'finished'
              ? wakeParent(loop.end.result.delivery, loop.trace)
              : Effect.void,
          ),
        ),
      params.parentRunId,
    );
    return Effect.map(launched, (fiber) => ({
      fiber,
      lastTurn: () =>
        loop.end.kind === 'finished' ? loop.end.turn : undefined,
    }));
  });
}
