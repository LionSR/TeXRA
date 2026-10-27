import { randomUUID } from 'node:crypto';
import {
  Cause,
  Clock,
  type Context,
  Effect,
  Exit,
  type Fiber,
  Scope,
  type Semaphore,
} from 'effect';

// Shared child accounting and durable delivery for native runs and processes.

import type { AgentTrace, StageHandle } from '@agent/trace';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { resolveChildRunConcurrencyBudget } from '@agent/runtime/childRunBudget';
import {
  registryOf,
  type RunRegistry,
  type AgentRunServices,
  Runs,
} from '@agent/runtime/runRegistry';
import {
  endRunOutsideLifecycle,
  letGoOfClaim,
} from '@agent/runtime/runLaunchGuard';
import type { RunInput } from '@agent/followUp/RunInput';
import { getRunRecords } from '@agent/storage/runRecords';
import {
  childTurnResult,
  commitPart,
  deliverIn,
  deliverLaunchFailure,
  parentEdgeIn,
  sendToParent,
  traceLog,
  turnResultPart,
  wakeParent,
  type ChildTurnResult,
  type TransactionPart,
  type TurnResultRow,
} from '@agent/runtime/childTurnResult';
import { isUserAbort } from '@common/errors/errorPredicates';
import {
  RUN_OUTCOME,
  qualifyAggregateId,
  type FollowUpContent,
  type ResultMeta,
  type RunId,
  type RunOutcome,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import {
  DatabaseNotOwner,
  type DatabaseWriteFailed,
} from '@shared/session/database';
import { RunHistoryRefused } from '@shared/session/runHistory';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { Alongside } from '@shared/session/sessionEvents';
import { formatSubagentProgress } from '@shared/subagentFollowup';
import { deriveRunOutcome } from '@shared/runs/runStatus';
import { aggregateError, onAbort } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

/** A stopped child's pause: the notice its parent reads, and the id a
 *  tool call names to continue it (a Codex thread, a Claude session), which
 *  the `child.park` row keeps so that call reactivates this same run. */
export interface ChildRunPause {
  readonly text: string;
  readonly resumeId?: string;
}

/** Presentation and finalization of a process child (agent CLI, background
 *  bash); a native run owns its handle and terminal and has no port. */
export interface ChildRunPort {
  readonly logger: AgentTrace;
  /** Show the handle to stops, once the loop has reserved their target. */
  track(): void;
  /** End the child through its handle; resolves once the terminal finalizer
   *  has written the end and untracked the handle. */
  finalize(options: {
    /** The last turn's result, written in the `run.end` transaction. */
    lastTurn?: TransactionPart;
    /** The child's report of its own exit, not a verdict: a stop that
     *  already landed CANCELLED outranks a FAILED this reports. */
    outcome: RunOutcome;
    /** Cause behind a FAILED outcome, for diagnosis. */
    error?: unknown;
    /** A stop the loop observed by finalize time: it outranks `outcome`. */
    stopped?: boolean;
    /** Session stage closed with the derived outcome (the loop's stage). */
    stage?: Pick<StageHandle, 'end'>;
    /** The strategy's {@link ProcessChildStrategy.pauseNotice}, read on a stop. */
    pauseNotice?: () => ChildRunPause | undefined;
  }): Effect.Effect<void, Error, Runs>;
}

/**
 * A native run's child policy: each turn runs under `turnPermit` (a child
 * waiting for input holds no slot) and its result commits in the batch that
 * ends it (its boundary's `waiting` row, or the last turn's `run.end`).
 */
export interface ChildRunTurns<TTurn> extends ChildRunBoundary<TTurn> {
  /** Finish the run's last turn: what its `run.end` transaction writes. A
   *  failure here is the loop's, raised once the run is joined. */
  finishLastTurn(turn: TTurn): Effect.Effect<TransactionPart | undefined>;
}

/** What a native run's loop takes of its child policy. */
export interface ChildRunBoundary<TTurn> {
  turnPermit<A, E, R>(
    turn: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Error, R>;
  /** Finish a turn the run goes on from: rows for its boundary batch, the
   *  parent's delivery written in that batch's transaction, and the parent's
   *  resume to run once the batch commits ({@link wakeParent}). */
  finishTurn(turn: TTurn): Effect.Effect<
    {
      readonly rows: readonly TurnResultRow[];
      readonly alongside: Alongside<Error> | undefined;
      readonly wakeParent: Effect.Effect<void, Error>;
    },
    Error
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
  /** `notify` is best-effort live progress. A child reports no spend: its
   *  priced calls are rows on its own run, summed over the run tree. */
  launch(
    notify: (update: SubagentProgressUpdate) => void,
    turns: ChildRunTurns<TTurn>,
  ): Effect.Effect<TTurn, Error, R>;
  /** Record the report without routing it to a parent: a headless caller
   *  awaits and reads it itself. */
  readonly deliveryMode?: 'persistOnly';
  /** An interrupted interactive turn has no new result to record. */
  isTurnInterrupted?(turn: TTurn): boolean;
  /** For a child a user stopped (directly or through its parent): what it
   *  had done and which run to resume, queued for the parent without
   *  waking it. */
  stopNotice?(): Effect.Effect<string, Error, R>;
  /** The one id a once-delivering child's result is admitted under, so a
   *  resumed child's delivery is a replay. Absent: each turn's own. */
  readonly deliveryId?: string;
}

/** An external process's strategy (agent CLI, background bash): each turn's
 *  result commits in the loop, which then waits for the child's next batch. */
export interface ProcessChildStrategy<
  TTurn,
  R = never,
> extends ChildStrategyBase<TTurn, R> {
  launch(signal: AbortSignal): Effect.Effect<TTurn, Error, R>;
  /** The next turn, from the queued follow-ups. Absent: the first turn is
   *  the only one (a background shell). */
  runTurn?(
    followUps: readonly FollowUpContent[],
    signal: AbortSignal,
  ): Effect.Effect<TTurn, Error, R>;
  /** Deliver a finished turn even when the loop was interrupted: only a
   *  killed OS process, whose exit code and output are a complete result. */
  readonly deliverAfterInterrupt?: boolean;
  /** A stop pauses this child rather than cancelling it: what it had done
   *  and how the parent's model continues it; undefined cancels it. */
  pauseNotice?(): ChildRunPause | undefined;
  /** After a successful turn: register the session/thread id, etc. */
  onTurnSuccess?(turn: TTurn): void;
  /** Release provider-owned registry entries; called once, before a failed
   *  or interrupted delivery or at the end. */
  releaseSessionOwnership?(): void;
}

/** The fields every child loop takes. */
interface ChildRunLoopShared {
  readonly session: SessionHandle;
  readonly parentRunId: RunId;
  /** The child's run: its input and its interrupt target. */
  readonly runId: RunId;
  readonly agentName: string;
  /** Replaces follow-up delivery of progress, for an awaiting caller whose
   *  blocked parent cannot read it (e.g. onto the parent's trace). */
  readonly notify?: (update: SubagentProgressUpdate) => void;
}

/**
 * One child loop's parameters, by family: a native child (no port), in the session's child-run budget
 * unless `awaited` (it rides its caller's slot), or a process child with the port that presents and ends it.
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
 * its turn, and `end`, its last turn's result. Its stop is the registry
 * activation; a process child hears it through `signal` and finalizes after
 * it, a native child's run fiber is interrupted.
 */
class ChildLoop<TTurn, R> {
  private readonly controller = new AbortController();
  /** The stop was a user's, read as it lands: its reason goes with the run. */
  userStopped = false;
  readonly trace: AgentTrace | undefined;
  readonly attemptId = randomUUID();
  /** What the launch acquired (its ownership, activation and stage),
   *  closed once: by the launch or its admission when the program never
   *  started, else last in the program's end. */
  readonly setup = Scope.makeUnsafe();
  stage: StageHandle | undefined;
  budget: Semaphore.Semaphore | undefined;
  /** Lets the child's claim go: a process child holds it for its loop's
   *  life; a native child's run claimed itself as it entered. */
  releaseClaim: Effect.Effect<void> = Effect.void;
  ownershipReleased = false;
  turnIndex = 0;
  turnStart = 0;
  /** The follow-ups the current turn's prompt took. */
  consumed: readonly QueuedFollowUp[] = [];
  /** Why the child failed; the cause may itself be `undefined`. */
  failure: { readonly cause: unknown } | undefined;
  end: ChildEnd = { kind: 'open' };

  constructor(
    readonly params: ChildRunLoopParams<TTurn, R>,
    readonly runs: RunRegistry,
  ) {
    this.trace = params.childRun?.logger;
  }

  /** The process strategy of a process child. */
  get process(): ProcessChildStrategy<TTurn, R> | undefined {
    const { params } = this;
    return params.childRun === undefined ? undefined : params.strategy;
  }

  interrupt(): void {
    const { runId, childRun } = this.params;
    this.userStopped ||= this.runs.get(runId)?.stopReason === 'user';
    this.controller.abort();
    if (childRun === undefined) this.runs.interrupt(runId);
  }

  isInterrupted(): boolean {
    return this.controller.signal.aborted;
  }

  /** The one signal every turn of this child runs under: no turn starts
   *  after an interrupt, so a per-turn one would mirror it. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Release provider-owned registry entries, once. */
  releaseOwnership(): void {
    if (this.ownershipReleased) return;
    this.ownershipReleased = true;
    this.process?.releaseSessionOwnership?.();
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

/** Run one turn: `undefined` when cleanly interrupted, else its turn (null
 *  when it threw), its error, and its application-level error flag. */
function attemptTurn<TTurn, R, RTurn>(
  loop: ChildLoop<TTurn, R>,
  run: Effect.Effect<TTurn, Error, RTurn>,
): Effect.Effect<Turned<TTurn> | undefined, never, RTurn> {
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
    const caught = Cause.squash(attempt.cause);
    if (loop.isInterrupted() || isUserAbort(caught)) return undefined;
    yield* loop.log('error', toErrorMessage(caught));
    return { turn: null, err: caught, turnIsError: false };
  });
}

/** A turn that threw, or reported an error without throwing, fails the
 *  child. */
const noteFailure = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  { err, turnIsError }: Turned<TTurn>,
): void => {
  if (err == null && !turnIsError) return;
  const { stageLabel } = loop.params.strategy;
  loop.failure = {
    cause:
      err ??
      new Error(`${stageLabel} reported a failed turn without throwing.`),
  };
};

/** A process child's waiting row (`child.park`): `parked` before the loop
 *  waits on its input, `resumed` when a batch it took starts the next turn. */
const waitingRow = (runId: RunId, phase: 'parked' | 'resumed') =>
  ({
    type: 'child.park',
    aggregateId: qualifyAggregateId('run', runId),
    phase,
  }) as const;

/** A native child's progress reaches its parent as a held follow-up, enqueued
 *  on the publisher where it is reported, ahead of the turn's result. */
const progressNotify =
  <TTurn, R>(
    loop: ChildLoop<TTurn, R>,
    strategy: NativeChildStrategy<TTurn, R>,
  ) =>
  (update: SubagentProgressUpdate): void => {
    const { notify, session, runId, agentName } = loop.params;
    if (notify) return notify(update);
    if (strategy.deliveryMode === 'persistOnly') return;
    if (loop.runs.parentOf(runId) === null) return;
    session.followUps.sendNotice(parentEdgeIn(session, runId), {
      text: formatSubagentProgress(runId, agentName, update),
      from: { kind: 'run', runId },
    });
  };

/**
 * Accept the next turn: its `child.turn accepted` row, the fact the
 * report/result slots are attributed from, with the `resumed` row that ends
 * the wait. Not best-effort: a refused append is the turn's failure, and
 * `not-owner` stops the loop rather than run under a lost claim.
 */
const beginTurn = Effect.fn('childRunLoop.beginTurn')(function* <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  resumed: boolean,
): Effect.fn.Return<void, DatabaseNotOwner | DatabaseWriteFailed> {
  const { runId, session } = loop.params;
  loop.turnIndex += 1;
  loop.turnStart = yield* Clock.currentTimeMillis;
  yield* session.log.transact([
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

/** Who reads this turn's result: its parent, unless the child is
 *  persist-only or stopped with nothing to deliver. A detach is read from
 *  the child's rows in the job delivering it (`deliverIn`). */
const deliveryTarget = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  isError: boolean,
): RunId | null => {
  const { params } = loop;
  const { parentRunId: target } = params;
  if (
    params.childRun === undefined &&
    params.strategy.deliveryMode === 'persistOnly'
  )
    return null;
  if (loop.isInterrupted()) {
    loop.releaseOwnership();
    return loop.process?.deliverAfterInterrupt === true ? target : null;
  }
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
): Effect.fn.Return<{ result: ChildTurnResult; turn: LastTurn }, Error, R> {
  const { params } = loop;
  const { strategy, runId } = params;
  if (loop.turnIndex === 0) yield* beginTurn(loop, false);
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
      params.childRun === undefined ? params.strategy.deliveryId : undefined,
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
): Effect.Effect<ChildEnd, never, R> =>
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
): Effect.fn.Return<void, Error, R> {
  const end =
    loop.end.kind === 'open'
      ? yield* recordLastTurn(loop, turned, false)
      : loop.end;
  if (end.kind === 'error') return yield* Effect.fail(end.error);
});

/** The turns a native run's own loop finishes, on its own fiber, under the
 *  services this loop runs with. */
function nativeTurns<TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  strategy: NativeChildStrategy<TTurn, R>,
  services: Context.Context<R>,
): ChildRunTurns<TTurn> {
  const { session } = loop.params;
  return {
    turnPermit: Effect.fn('childRunLoop.turnPermit')(function* (turn) {
      if (loop.isInterrupted()) return yield* Effect.interrupt;
      yield* beginTurn(loop, false);
      return yield* loop.budget ? loop.budget.withPermit(turn) : turn;
    }),
    finishTurn: (turn) =>
      Effect.map(
        buildTurnResult(loop, { turn, err: null, turnIsError: false }),
        ({ result: { rows, delivery } }) => ({
          rows,
          alongside:
            delivery &&
            Effect.map(
              deliverIn(session, delivery, loop.trace),
              (part) => part.rows,
            ),
          wakeParent: wakeParent(session, delivery, loop.trace),
        }),
      ).pipe(Effect.provide(services)),
    // The native run's own `run.end` commits these.
    finishLastTurn: (turn) =>
      strategy.isTurnInterrupted?.(turn) === true
        ? Effect.succeed(undefined)
        : recordLastTurn(
            loop,
            {
              turn,
              err: null,
              turnIsError: strategy.isTurnError?.(turn) === true,
            },
            true,
          ).pipe(
            Effect.map((end) =>
              end.kind === 'finished'
                ? turnResultPart(session, end.result, loop.trace)
                : undefined,
            ),
            Effect.provide(services),
          ),
  };
}

/**
 * A process child's interim turn, in one transaction: its result, its
 * parent's delivery and (unless stopped) the `parked` row, durable before
 * the loop waits so a follow-up is accepted; then the ids it answers to
 * (so one sent on them finds it waiting, never mid-turn), and the parent's
 * resume.
 */
const finishInterimTurn = Effect.fn('childRunLoop.finishInterimTurn')(
  function* <TTurn, R>(
    loop: ChildLoop<TTurn, R>,
    turned: Turned<TTurn>,
  ): Effect.fn.Return<void, Error, R> {
    const { session, runId } = loop.params;
    const { result } = yield* buildTurnResult(loop, turned);
    const wait = loop.isInterrupted() ? undefined : waitingRow(runId, 'parked');
    yield* commitPart(
      session,
      turnResultPart(session, result, loop.trace, wait),
    );
    if (wait && turned.turn !== null && !loop.isInterrupted())
      loop.process?.onTurnSuccess?.(turned.turn);
    yield* wakeParent(session, result.delivery, loop.trace);
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
): Effect.fn.Return<TTurn | undefined, Error, R> {
  const { session, runId } = loop.params;
  // A stop that landed during the setup: the run never launches.
  if (loop.isInterrupted()) return undefined;
  const turns = nativeTurns(loop, strategy, yield* Effect.context<R>());
  loop.turnStart = yield* Clock.currentTimeMillis;
  const turned = yield* attemptTurn(
    loop,
    Effect.suspend(() =>
      strategy.launch(progressNotify(loop, strategy), turns),
    ),
  );
  if (turned === undefined) return undefined;
  const { turn, err } = turned;
  if (turn !== null && strategy.isTurnInterrupted?.(turn)) {
    loop.interrupt();
    return turn;
  }
  noteFailure(loop, turned);
  // A launch can fail before its first cycle, and before its run's birth.
  if (
    loop.turnIndex === 0 &&
    loop.failure !== undefined &&
    !(yield* session.log.owns(runId))
  ) {
    if (strategy.deliveryMode !== 'persistOnly') {
      const wallTimeMs = (yield* Clock.currentTimeMillis) - loop.turnStart;
      const message = strategy.formatError(turn, err, wallTimeMs);
      yield* deliverLaunchFailure(session, runId, message);
    }
    return yield* Effect.fail(ensureError(loop.failure.cause));
  }
  yield* endTurns(loop, turned);
  return turn ?? undefined;
});

/**
 * A process child: each turn's result commits here before the loop waits on
 * `input` for its next batch (raced against the loop's stop).
 */
const driveProcess = Effect.fn('childRunLoop.driveProcess')(function* <
  TTurn,
  R,
>(
  loop: ChildLoop<TTurn, R>,
  strategy: ProcessChildStrategy<TTurn, R>,
  input: RunInput,
): Effect.fn.Return<TTurn | undefined, Error, R> {
  let next = () => strategy.launch(loop.signal);
  let result: TTurn | undefined;
  let resumed = false;
  while (!loop.isInterrupted()) {
    yield* beginTurn(loop, resumed);
    const turned = yield* attemptTurn(loop, Effect.suspend(next));
    if (turned === undefined) break;
    const { turn } = turned;
    if (turn !== null) result = turn;
    noteFailure(loop, turned);
    const runTurn = strategy.runTurn;
    if (loop.failure !== undefined || turn === null || !runTurn) {
      yield* endTurns(loop, turned);
      break;
    }
    yield* finishInterimTurn(loop, turned);
    const batch = loop.isInterrupted()
      ? null
      : yield* Effect.raceFirst(
          input.next('idle'),
          Effect.callback<null>((resume) =>
            Effect.sync(
              onAbort(loop.signal, () => resume(Effect.succeed(null))),
            ),
          ),
        ).pipe(Effect.interruptible);
    if (!batch || loop.isInterrupted()) break;
    // The batch ends the wait: the turn it starts is the current one.
    loop.consumed = batch.kind === 'synthetic' ? [] : batch.followUps;
    resumed = true;
    const prompts: readonly FollowUpContent[] =
      batch.kind === 'synthetic'
        ? [{ text: batch.text, from: { kind: 'user' } }]
        : loop.consumed.map((followUp) => followUp.content);
    next = () => runTurn(prompts, loop.signal);
  }
  return result;
});

/**
 * A native child's end outside its exited lifecycle (an end it wrote
 * stands), or its last turn's result alone; a user's stop then queues
 * what the child left for its parent to resume.
 */
const endNative = Effect.fn('childRunLoop.endNative')(function* <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  strategy: NativeChildStrategy<TTurn, R>,
  outcome: RunOutcome,
  stopped: boolean,
  lastTurn: TransactionPart | undefined,
): Effect.fn.Return<void, Error, R | Runs> {
  const { session, runId } = loop.params;
  const abnormal = stopped || loop.failure !== undefined;
  if (abnormal && (yield* session.log.owns(runId)))
    yield* endRunOutsideLifecycle(
      session,
      runId,
      outcome,
      loop.failure?.cause,
      lastTurn,
    );
  else if (!abnormal && lastTurn !== undefined)
    yield* commitPart(session, lastTurn);
  if (
    strategy.stopNotice === undefined ||
    strategy.deliveryMode === 'persistOnly' ||
    !loop.userStopped
  )
    return;
  // A notice that cannot be read still says the child stopped: the stop
  // stands, and the failure is loud.
  const text = yield* strategy
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
  yield* sendToParent(session, item, { hold: 'instruction' }, loop.trace);
});

/** The child's terminal row, its process port's finalize or a native run's
 *  end, carrying the last turn's result unless its run's end took it. */
const writeEnd = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  stopped: boolean,
): Effect.Effect<void, Error, R | Runs> => {
  const { params, end } = loop;
  // Re-read: a stop landing after the body's exit is still the run's
  // terminal verdict.
  const stoppedAtExit = stopped || loop.isInterrupted();
  const outcome = deriveRunOutcome({
    failed: loop.failure !== undefined,
    cancelled: stoppedAtExit,
  });
  const lastTurn =
    end.kind === 'finished' && !end.handedOff
      ? turnResultPart(params.session, end.result, loop.trace)
      : undefined;
  if (params.childRun === undefined)
    return endNative(loop, params.strategy, outcome, stoppedAtExit, lastTurn);
  return params.childRun.finalize({
    lastTurn,
    outcome,
    error: loop.failure?.cause,
    stopped: stoppedAtExit,
    stage: loop.stage,
    pauseNotice: params.strategy.pauseNotice,
  });
};

/**
 * The loop's terminal (exit protocol): a stop lands before or after it, so
 * the terminal row, the provider ids, the claim, the parent's resume and
 * the setup are all handled on every exit; the body's failure propagates as
 * itself, joined by the cleanup's.
 */
const endChildLoop = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  body: Exit.Exit<TTurn | undefined, Error>,
): Effect.Effect<void, Error, R | Runs> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const stopped =
        loop.isInterrupted() ||
        (Exit.isFailure(body) && Cause.hasInterrupts(body.cause));
      if (Exit.isFailure(body) && !Cause.hasInterruptsOnly(body.cause)) {
        const error = Cause.squash(body.cause);
        loop.failure ??= { cause: error };
        // A lost aggregate claim: this process no longer owns the run, so
        // the loop (and its process) stops rather than continue under it.
        if (
          error instanceof DatabaseNotOwner ||
          (error instanceof RunHistoryRefused && error.reason === 'not-owner')
        )
          loop.interrupt();
      }
      // Debug-only driver diagnostic: how the loop ended.
      yield* loop.log('debug', 'childRunLoop loop.terminated', {
        runId: loop.params.runId,
        stopped,
        failed: loop.failure !== undefined,
      });
      const { end } = loop;
      const terminal = yield* Effect.exit(writeEnd(loop, stopped));
      // Provider ids stay reserved until the terminal (or pause) row is
      // written, so a call naming one finds this run, not a gap.
      const owned = yield* Effect.exit(
        Effect.sync(() => loop.releaseOwnership()),
      );
      // The parent may immediately read this child; release its claim first.
      yield* loop.releaseClaim;
      const wake = yield* Effect.exit(
        wakeParent(
          loop.params.session,
          end.kind === 'finished' ? end.result.delivery : undefined,
          loop.trace,
        ),
      );
      // Last, the stop target: the setup's activation.
      const setup = yield* Effect.exit(Scope.close(loop.setup, Exit.void));
      const failures = [terminal, owned, wake, setup].flatMap((exit) =>
        Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : [],
      );
      if (failures.length > 0)
        return yield* Effect.fail(
          ensureError(aggregateError(failures, 'Child run and cleanup failed')),
        );
    }),
  );

/** The launched run: the child's claim for its whole life, a process
 *  child's reader, its turns, and its terminal on every exit. */
const runChildLoop = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
): Effect.Effect<TTurn | undefined, Error, R | Runs> =>
  Effect.gen(function* () {
    const { params } = loop;
    const { session, runId } = params;
    // A run that exists is held for the loop's life (a resume's hold goes
    // when it hands over); a fresh native one claims itself at birth.
    const held =
      params.childRun !== undefined ||
      (yield* getRunRecords(session, runId).exists());
    const claimHeld = yield* Scope.make();
    if (held)
      yield* session.log.hold(runId, { ends: true }).pipe(
        Scope.provide(claimHeld),
        Effect.onError(() => Scope.close(claimHeld, Exit.void)),
      );
    loop.releaseClaim = held
      ? Scope.close(claimHeld, Exit.void)
      : letGoOfClaim(session, runId);
    // A native child's own loop opens its reader, as any run's loop does.
    if (params.childRun === undefined)
      return yield* driveNative(loop, params.strategy);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const reader = yield* session.followUps.open(runId);
        // Its end is the child's: it takes no more input here.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => session.followUps.release(runId, reader, true)),
        );
        return yield* driveProcess(loop, params.strategy, reader);
      }),
    );
  }).pipe(Effect.onExit((body) => endChildLoop(loop, body)));

/** A child that never started: its setup unwinds (once the program started,
 *  its end closed it), a rollback that fails joins the cause loudly, and
 *  anything but an interruption fails as an `Error`. */
const failUnstarted =
  (setup: Scope.Closeable, runId: RunId) =>
  <A, R>(self: Effect.Effect<A, Error, R>): Effect.Effect<A, Error, R> =>
    Effect.catchCause(self, (cause) =>
      Effect.flatMap(Effect.exit(Scope.close(setup, Exit.void)), (closed) => {
        if (Exit.isSuccess(closed) && Cause.hasInterruptsOnly(cause))
          return Effect.failCause(cause);
        const failures = Exit.isSuccess(closed) ? [] : [closed.cause];
        return Effect.fail(
          ensureError(
            aggregateError(
              [cause, ...failures].map((c) => Cause.squash(c)),
              `Child run ${runId} setup failed and rollback was incomplete`,
            ),
          ),
        );
      }),
    );

/** Reserve the child's stop target, budget and stage, each release on the
 *  setup scope (ownership first, so a refused activation still lets an agent
 *  CLI's provider ids go), then launch its run, admitted a tick later. */
const launchChildLoop = Effect.fn('childRunLoop.launchChildLoop')(function* <
  TTurn,
  R extends AgentRunServices,
>(
  loop: ChildLoop<TTurn, R>,
): Effect.fn.Return<Fiber.Fiber<TTurn | undefined, Error>, Error, R | Runs> {
  const { params, setup } = loop;
  const { childRun, runId } = params;
  yield* Scope.addFinalizer(
    setup,
    Effect.sync(() => loop.releaseOwnership()),
  );
  // Every child loop reserves its stop target for its whole life.
  const releaseActivation = loop.runs.reserveChildActivation({
    runId,
    launchParent: params.parentRunId,
    interrupt: () => loop.interrupt(),
  });
  yield* Scope.addFinalizer(setup, Effect.sync(releaseActivation));
  // Read after the reservation, so no stop lands while there is no target.
  if (params.childRun === undefined && params.awaited !== true)
    loop.budget = yield* loop.runs.childRunBudget(
      yield* resolveChildRunConcurrencyBudget(params.session.roots),
    );
  const stage = yield* Effect.sync(() => {
    // A stop sees the handle only from here, with its target reserved.
    childRun?.track();
    return loop.trace?.openStage(params.strategy.stageLabel);
  });
  if (stage !== undefined) {
    loop.stage = stage;
    yield* Scope.addFinalizer(
      setup,
      Effect.sync(() => stage.end(RUN_OUTCOME.FAILED)),
    );
  }
  return yield* loop.runs.start(runId, runChildLoop(loop), (admitted) =>
    Effect.andThen(Effect.yieldNow, admitted).pipe(failUnstarted(setup, runId)),
  );
});

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
    // The handoff never happened: the setup this launch acquired unwinds
    // here rather than leaking the activation and the stage.
    return launchChildLoop(loop).pipe(
      failUnstarted(loop.setup, params.runId),
      Effect.map((fiber) => ({
        fiber,
        lastTurn: () =>
          loop.end.kind === 'finished' ? loop.end.turn : undefined,
      })),
    );
  });
}
