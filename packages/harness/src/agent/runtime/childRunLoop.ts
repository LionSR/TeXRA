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
  commitPart,
  deliverIn,
  deliverLaunchFailure,
  parentEdgeIn,
  sendToParent,
  settleChildTurn,
  childSettlementOf,
  type ChildSettlement,
  type SettlementRow,
  traceLog,
  type TransactionPart,
  wakeParent,
} from '@agent/runtime/childSettlement';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
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
import { formatSubagentProgress } from '@shared/subagentFollowup';
import { deriveRunOutcome } from '@shared/runs/runStatus';
import { aggregateError, onAbort } from '@utils/core';
import { formatDuration } from '@utils/text/stringUtils';
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
   *  has persisted, settled and untracked. */
  finalize(options: {
    /** The last turn's settlement, written in the `run.end` transaction. */
    settlement?: TransactionPart;
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
 * A native run's child policy: each turn runs under `turnPermit` (a WAITING
 * child holds no slot) and settles in the batch that ends it (its boundary's
 * `waiting` step, or the last turn's `run.end`).
 */
export interface ChildRunTurns<TTurn> extends ChildRunBoundary<TTurn> {
  /** Settle the run's last turn: what its `run.end` transaction writes. A
   *  failure here is the loop's, raised once the run is joined. */
  settleEnd(turn: TTurn): Effect.Effect<TransactionPart | undefined>;
}

/** What a native run's loop takes of its child policy. */
export interface ChildRunBoundary<TTurn> {
  turnPermit<A, E, R>(
    turn: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Error, R>;
  /** Settle a turn the run goes on from: rows for its boundary batch, and
   *  the parent's delivery written in that batch's transaction. */
  settleBoundary(turn: TTurn): Effect.Effect<
    {
      readonly rows: readonly SettlementRow[];
      readonly alongside: TransactionPart | undefined;
      readonly settled: Effect.Effect<void, Error>;
    },
    Error
  >;
}

/** What every child strategy says of its turns; `R` names the services a
 *  turn reads, forwarded to the loop's caller. */
interface ChildStrategyBase<TTurn, R> {
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
  formatError(turn: TTurn | null, err: unknown): string;
  /** The result manifest persisted beside each turn's report, success or
   *  failure (`turn` null and `error` the throw when the call threw), so a
   *  failure overwrites a stale interim one. */
  buildResultMeta?(
    turn: TTurn | null,
    isError: boolean,
    wallTimeMs: number,
    error?: unknown,
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
  /** An interrupted interactive turn has no new result to settle. */
  isTurnInterrupted?(turn: TTurn): boolean;
  /** For a child a user stopped (directly or through its parent): what it
   *  had done and which run to resume, queued for the parent without
   *  waking it. */
  stopNotice?(): Effect.Effect<string, Error, R>;
  /** The one id a once-delivering child's result is admitted under, so a
   *  resumed child's delivery is a replay. Absent: each turn's own. */
  readonly deliveryId?: string;
}

/** An external process's strategy (agent CLI, background bash): each turn
 *  settles in the loop, which then waits for the child's next batch. */
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
  /** Deliver a settled turn even when the loop was interrupted: only a
   *  killed OS process, whose exit code and output are a complete result. */
  readonly deliverAfterInterrupt?: boolean;
  /** A stop pauses this child rather than cancelling it: what it had done
   *  and how the parent's model continues it; undefined cancels it. */
  pauseNotice?(): ChildRunPause | undefined;
  /** After a successful turn: register the session/thread id, etc. */
  onTurnSuccess?(turn: TTurn, session: SessionHandle): void;
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
  /** An awaiting caller's copy of each settled turn's facts, after
   *  persistence; a required-durability caller verifies the store itself. */
  readonly onTurnSettled?: (settled: {
    readonly message: string;
    readonly resultMeta?: ResultMeta;
    readonly isError: boolean;
    readonly error?: unknown;
  }) => void;
}

/**
 * One child loop's parameters, by family: a native child (no port), gated
 * by the session's child-run budget when `budgeted`
 * (`.agents/docs/implemented/architecture/2026-08-15-child-run-concurrency-budget.md`),
 * or a process child with the port that presents and ends it, outside it.
 */
export type ChildRunLoopParams<TTurn, R = never> = ChildRunLoopShared &
  (
    | {
        readonly childRun?: undefined;
        readonly budgeted: boolean;
        readonly strategy: NativeChildStrategy<TTurn, R>;
      }
    | {
        readonly childRun: ChildRunPort;
        readonly strategy: ProcessChildStrategy<TTurn, R>;
      }
  );

/** The child's last turn as its end writes it: not settled (a stop, an
 *  interrupted turn); settled, with the report an awaiting caller reads
 *  (`handedOff`: given to a native run's own `run.end`, before it commits);
 *  or a settlement that failed, the loop's failure once the run is joined,
 *  its end written bare. */
type ChildEnd =
  | { readonly kind: 'open' }
  | {
      readonly kind: 'settled';
      readonly settlement: ChildSettlement;
      readonly report: Effect.Effect<void>;
      readonly handedOff: boolean;
    }
  | { readonly kind: 'unsettled'; readonly error: Error };

/**
 * One child loop's state, passed through the functions below: its setup,
 * its turn, and `end`, its last turn's settlement. Its stop is the registry
 * activation; a process child hears it through `signal` and finalizes after
 * it (2026-08-01), a native child's run fiber is interrupted.
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
          `Turn completed in ${formatDuration(wallTimeMs)}`,
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

/** A process child's park (3.3): `parked` before the loop blocks on its
 *  queue, `resumed` when a taken batch starts the next turn. */
const parkRow = (runId: RunId, phase: 'parked' | 'resumed') =>
  ({
    type: 'child.park',
    aggregateId: qualifyAggregateId('run', runId),
    phase,
  }) as const;

/** A native child's progress reaches the parent as queued follow-ups,
 *  enqueued on the session's publisher where it is reported, so each
 *  commits ahead of the turn's result. */
const progressNotify =
  <TTurn, R>(
    loop: ChildLoop<TTurn, R>,
    strategy: NativeChildStrategy<TTurn, R>,
  ) =>
  (update: SubagentProgressUpdate): void => {
    const { notify, session, runId, agentName } = loop.params;
    if (notify) return notify(update);
    const target = loop.runs.parentOf(runId);
    if (strategy.deliveryMode === 'persistOnly' || target === null) return;
    // Nothing is queued when no session holds the run.
    if (loop.runs.getToolUseFollowUpTarget(target).kind === 'no_session')
      return;
    session.followUps.sendDetached(parentEdgeIn(session, runId), {
      text: formatSubagentProgress(runId, agentName, update),
      from: { kind: 'run', runId },
    });
  };

/**
 * Accept the next turn: its `child.turn accepted` row (#9531), the fact the
 * report/result slots are attributed from, with the `resumed` park it
 * leaves. Not best-effort: a refused append is the turn's failure, and
 * `not-owner` stops the loop rather than run under a lost claim (R7).
 */
const beginTurn = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  resumed: boolean,
): Effect.Effect<void, DatabaseNotOwner | DatabaseWriteFailed> =>
  Effect.gen(function* () {
    const { runId, session } = loop.params;
    loop.turnIndex += 1;
    loop.turnStart = yield* Clock.currentTimeMillis;
    yield* session.log.transact([
      ...(resumed ? [parkRow(runId, 'resumed')] : []),
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

/** One turn's settlement, and the report an awaiting caller reads once it
 *  commits (or once its commit failed, then the turn's failure). */
const settleTurn = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  { turn, err, turnIsError }: Turned<TTurn>,
  last = false,
): Effect.Effect<
  { settlement: ChildSettlement; report: Effect.Effect<void> },
  Error,
  R
> =>
  Effect.gen(function* () {
    const { params } = loop;
    const { strategy, runId } = params;
    if (loop.turnIndex === 0) yield* beginTurn(loop, false);
    const wallTimeMs = (yield* Clock.currentTimeMillis) - loop.turnStart;
    const isError = err != null || turnIsError;
    const message =
      turn != null && !isError
        ? yield* strategy.formatDelivery(turn, wallTimeMs)
        : yield* Effect.try({
            try: () => strategy.formatError(turn, err),
            catch: ensureError,
          });
    const resultMeta = strategy.buildResultMeta
      ? yield* strategy.buildResultMeta(
          turn,
          isError,
          wallTimeMs,
          err ?? undefined,
        )
      : undefined;
    const settlement = childSettlementOf({
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
    const report = Effect.sync(() =>
      params.onTurnSettled?.({
        message,
        ...(resultMeta !== undefined && { resultMeta }),
        isError,
        ...(err != null && { error: err }),
      }),
    );
    return { settlement, report };
  });

/** Settle the last turn as the child's end, which writes it with its
 *  `run.end` (`handedOff`: a native run's own). A failure is the loop's,
 *  raised once the run is joined. */
const settleEnd = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  turned: Turned<TTurn>,
  handedOff: boolean,
): Effect.Effect<ChildEnd, never, R> =>
  settleTurn(loop, turned, true).pipe(
    Effect.map((settled): ChildEnd => ({
      kind: 'settled',
      ...settled,
      handedOff,
    })),
    Effect.catch((error) =>
      Effect.succeed<ChildEnd>({ kind: 'unsettled', error }),
    ),
    Effect.tap((end) => Effect.sync(() => (loop.end = end))),
  );

/** The last turn ends the child: settled here unless a native run's own
 *  `run.end` took it; a settlement that failed is the loop's failure. */
const endTurns = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  turned: Turned<TTurn>,
): Effect.Effect<void, Error, R> =>
  Effect.gen(function* () {
    const end =
      loop.end.kind === 'open'
        ? yield* settleEnd(loop, turned, false)
        : loop.end;
    if (end.kind === 'unsettled') return yield* Effect.fail(end.error);
  });

/** The turns a native run's own loop settles, on its own fiber, under the
 *  services this loop runs with. */
function nativeTurns<TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  strategy: NativeChildStrategy<TTurn, R>,
  services: Context.Context<R>,
): ChildRunTurns<TTurn> {
  const { session } = loop.params;
  return {
    turnPermit: (turn) =>
      Effect.gen(function* () {
        if (loop.isInterrupted()) return yield* Effect.interrupt;
        yield* beginTurn(loop, false);
        return yield* loop.budget ? loop.budget.withPermit(turn) : turn;
      }),
    settleBoundary: (turn) =>
      Effect.map(
        settleTurn(loop, { turn, err: null, turnIsError: false }),
        ({ settlement, report }) => {
          const { rows, delivery } = settlement;
          return {
            rows,
            alongside: delivery && deliverIn(session, delivery, loop.trace),
            settled: Effect.andThen(
              report,
              wakeParent(session, delivery, loop.trace),
            ),
          };
        },
      ).pipe(Effect.provide(services)),
    // The native run's own `run.end` commits these.
    settleEnd: (turn) =>
      strategy.isTurnInterrupted?.(turn) === true
        ? Effect.succeed(undefined)
        : settleEnd(
            loop,
            {
              turn,
              err: null,
              turnIsError: strategy.isTurnError?.(turn) === true,
            },
            true,
          ).pipe(
            Effect.map((end) =>
              end.kind === 'settled'
                ? settleChildTurn(session, end.settlement, loop.trace)
                : undefined,
            ),
            Effect.provide(services),
          ),
  };
}

/**
 * A process child's interim turn, in one transaction: its settlement, its
 * parent's delivery and (unless stopped) the `parked` row, durable before
 * the loop blocks so a follow-up is admitted; then the ids it answers to
 * (so one sent on them finds it waiting, never mid-turn), report and wake.
 */
const settleInterim = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  turned: Turned<TTurn>,
): Effect.Effect<void, Error, R> =>
  Effect.gen(function* () {
    const { session, runId } = loop.params;
    const { settlement, report } = yield* settleTurn(loop, turned);
    const park = loop.isInterrupted() ? undefined : parkRow(runId, 'parked');
    yield* commitPart(
      session,
      settleChildTurn(session, settlement, loop.trace, park),
    );
    if (park && turned.turn !== null && !loop.isInterrupted())
      loop.process?.onTurnSuccess?.(turned.turn, session);
    yield* report;
    yield* wakeParent(session, settlement.delivery, loop.trace);
  });

/**
 * A native child: its launch runs the whole run on its own fiber and offers
 * its turn boundaries through `nativeTurns`; a launch that fails before its
 * run's birth tells the parent as input alone.
 */
const driveNative = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  strategy: NativeChildStrategy<TTurn, R>,
): Effect.Effect<TTurn | undefined, Error, R> =>
  Effect.gen(function* () {
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
      if (strategy.deliveryMode !== 'persistOnly')
        yield* deliverLaunchFailure(
          session,
          runId,
          strategy.formatError(turn, err),
        );
      return yield* Effect.fail(ensureError(loop.failure.cause));
    }
    yield* endTurns(loop, turned);
    return turn ?? undefined;
  });

/**
 * A process child: each turn settles here before the loop waits on `input`
 * for its next batch (raced against the loop's stop).
 */
const driveProcess = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  strategy: ProcessChildStrategy<TTurn, R>,
  input: RunInput,
): Effect.Effect<TTurn | undefined, Error, R> =>
  Effect.gen(function* () {
    const { runId } = loop.params;
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
      yield* settleInterim(loop, turned);
      const batch = loop.isInterrupted()
        ? null
        : yield* Effect.raceFirst(
            input.take,
            Effect.callback<null>((resume) =>
              Effect.sync(
                onAbort(loop.signal, () => resume(Effect.succeed(null))),
              ),
            ),
          ).pipe(Effect.interruptible);
      if (!batch || loop.isInterrupted()) break;
      // A view edit is asked of a root's own loop, never of a child.
      if (batch.kind === 'edit')
        return yield* Effect.die(
          new Error(`${runId}: a child run took a view edit`),
        );
      // The batch leaves the park: the turn it starts is the top's.
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
 * stands), or its last turn's settlement alone; a user's stop then queues
 * what the child left for its parent to resume.
 */
const endNative = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  strategy: NativeChildStrategy<TTurn, R>,
  outcome: RunOutcome,
  stopped: boolean,
  settlement: TransactionPart | undefined,
): Effect.Effect<void, Error, R | Runs> =>
  Effect.gen(function* () {
    const { session, runId } = loop.params;
    const abnormal = stopped || loop.failure !== undefined;
    if (abnormal && (yield* session.log.owns(runId)))
      yield* endRunOutsideLifecycle(
        session,
        runId,
        outcome,
        loop.failure?.cause,
        settlement,
      );
    else if (!abnormal && settlement !== undefined)
      yield* commitPart(session, settlement);
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
 *  end, carrying the last turn's settlement unless its run's end took it. */
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
  const settlement =
    end.kind === 'settled' && !end.handedOff
      ? settleChildTurn(params.session, end.settlement, loop.trace)
      : undefined;
  if (params.childRun === undefined)
    return endNative(loop, params.strategy, outcome, stoppedAtExit, settlement);
  return params.childRun.finalize({
    settlement,
    outcome,
    error: loop.failure?.cause,
    stopped: stoppedAtExit,
    stage: loop.stage,
    pauseNotice: params.strategy.pauseNotice,
  });
};

/**
 * The loop's terminal (exit protocol): a stop lands before or after it, so
 * the lease, the terminal row, the claim, the wake and the setup settle on
 * every exit; the body's failure propagates as itself, joined by the
 * cleanup's.
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
      // Debug-only driver diagnostic (#9531): how the loop ended.
      yield* loop.log('debug', 'childRunLoop loop.terminated', {
        runId: loop.params.runId,
        stopped,
        failed: loop.failure !== undefined,
      });
      const { end } = loop;
      // The last turn's facts reach an awaiting caller before the child
      // ends, as every earlier turn's did.
      if (end.kind === 'settled') yield* end.report;
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
          end.kind === 'settled' ? end.settlement.delivery : undefined,
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
const launchChildLoop = <TTurn, R extends AgentRunServices>(
  loop: ChildLoop<TTurn, R>,
): Effect.Effect<Fiber.Fiber<TTurn | undefined, Error>, Error, R | Runs> =>
  Effect.gen(function* () {
    const { params, setup } = loop;
    const { childRun, runId } = params;
    yield* Scope.addFinalizer(
      setup,
      Effect.sync(() => loop.releaseOwnership()),
    );
    // Every child loop reserves its stop target for its whole life; only a
    // native one retains a terminal parent's continuation.
    const releaseActivation = loop.runs.reserveChildActivation({
      runId,
      launchParent: params.parentRunId,
      retainsTerminalParent: childRun === undefined,
      interrupt: () => loop.interrupt(),
    });
    yield* Scope.addFinalizer(setup, Effect.sync(releaseActivation));
    // Read after the reservation, so no stop lands while there is no target.
    if (params.childRun === undefined && params.budgeted)
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
      Effect.andThen(Effect.yieldNow, admitted).pipe(
        failUnstarted(setup, runId),
      ),
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
): Effect.Effect<Fiber.Fiber<TTurn | undefined, Error>, Error, R | Runs> {
  return Effect.flatMap(Runs, (runs) => {
    const loop = new ChildLoop(params, registryOf(runs));
    // The handoff never happened: the setup this launch acquired unwinds
    // here rather than leaking the activation and the stage.
    return launchChildLoop(loop).pipe(failUnstarted(loop.setup, params.runId));
  });
}
