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
  Runs,
  type AgentRunServices,
  type RunRegistry,
} from '@agent/runtime/runRegistry';
import type { RunParent } from '@agent/runtime/RunHandle';
import { endRunOutsideLifecycle } from '@agent/runtime/runLaunchGuard';
import type { RunInput } from '@agent/followUp/RunInput';
import {
  commitPart,
  deliverIn,
  settleChildTurn,
  settlementOf,
  type ChildSettlement,
  type SettlementRow,
  type TransactionPart,
  wakeParent,
} from '@agent/runtime/childSettlement';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import { withLogChannel } from '@logger/effectLog';
import {
  RUN_OUTCOME,
  qualifyAggregateId,
  type FollowUpContent,
  type DeliveredResult,
  type RunId,
  type RunOutcome,
  type SubagentProgressUpdate,
  type TokenUsageStats,
} from '@shared/schemas';
import {
  DatabaseNotOwner,
  type DatabaseWriteFailed,
} from '@shared/session/database';
import type { QueuedFollowUp } from '@shared/session/runRows';
import { formatSubagentProgress } from '@shared/subagentFollowup';
import { deriveRunOutcome } from '@shared/runs/runStatus';
import { aggregateError, onAbort } from '@utils/core';
import { formatDuration } from '@utils/text/stringUtils';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

/**
 * Capabilities the loop provides to a strategy for the duration of one child
 * run. `notify` is best-effort live progress (no persistence, no gating; one
 * delivery site per turn, so there is nothing to dedupe).
 *
 * A child reports no spend here: each of its priced model calls is one row
 * on its own run, and a parent's or a session's total is the sum over the
 * run tree (`RunView.usage` per run), never a figure a child hands up.
 */
export interface ChildRunPorts {
  notify(update: SubagentProgressUpdate): void;
}

/** A stopped child's pause: the notice its parent reads, and the id a
 *  tool call names to continue it (a Codex thread, a Claude session), which
 *  the `child.park` row keeps so that call reactivates this same run. */
export interface ChildRunPause {
  readonly text: string;
  readonly resumeId?: string;
}

/**
 * Presentation and finalization for process-backed children (agent CLIs,
 * background bash). Native engines own their run handle
 * and terminal finalization and omit this port.
 */
export interface ChildRunPort {
  readonly logger: AgentTrace;
  /** Show the handle to stops, once the loop has reserved their target. */
  track(): void;
  /**
   * Complete the child stream lifecycle through the owning run handle.
   * Resolves once the shared terminal finalizer has persisted, settled, and
   * untracked.
   */
  finalize(options: {
    /** The last turn's settlement and its parent's delivery, written in the
     *  transaction of the child's `run.end`. */
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
    /** The strategy's {@link ChildRunStrategy.pauseNotice}, read on a stop. */
    pauseNotice?: () => ChildRunPause | undefined;
  }): Effect.Effect<void, Error, Runs>;
}

/**
 * A native run's child policy: each turn runs under `turnPermit` (so a WAITING
 * child holds no slot), and each turn settles in the batch that ends it: a
 * boundary's rows and its parent's delivery commit with its `waiting` step,
 * and `settled` runs once they are durable; the last turn's commit with the
 * run's `run.end`.
 */
export interface ChildRunTurns<TTurn> extends ChildRunBoundary<TTurn> {
  /** Settle the run's last turn: what its `run.end` transaction writes. A
   *  failure here is the loop's, raised once the run is joined, never the
   *  ending's. */
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

export interface ChildRunStrategy<TTurn, R = never> {
  /** A native program owns its input wait and offers each turn boundary. */
  readonly continuous?: true;
  /** Stage label opened on the child trace (e.g. "Codex session"). */
  readonly stageLabel: string;

  /** Deliver a settled turn even when the loop was interrupted: only a
   *  killed OS process, whose exit code and output are a complete result. */
  readonly deliverAfterInterrupt?: boolean;

  /** `persistOnly` records the report without routing it to a parent, for
   *  a headless caller that awaits and reads it itself. */
  readonly deliveryMode?: 'persistOnly';

  /** A stop pauses this child rather than cancelling it: what it had done
   *  and how the parent's model continues it; undefined cancels it. */
  pauseNotice?(): ChildRunPause | undefined;

  /**
   * A native child a user stopped, directly or by stopping its parent: the
   * notice its parent reads, saying what it had done and which run to
   * resume. Queued for the parent's next input without waking it. A process
   * child says this through `pauseNotice`.
   */
  stopNotice?(): Effect.Effect<string, Error, R>;

  /**
   * The one id this child's result is admitted under, for a child that
   * delivers once in its life: a resumed child's delivery is then judged a
   * replay of one its earlier owner admitted. Absent: each turn's own.
   */
  readonly deliveryId?: string;

  /**
   * Produce the first turn's outcome. Throws on hard failure. `R` names the
   * process services a turn reads, forwarded to the loop's caller.
   */
  launch(
    ports: ChildRunPorts,
    signal: AbortSignal,
    turns: ChildRunTurns<TTurn>,
  ): Effect.Effect<TTurn, Error, R>;

  /**
   * Produce the next turn's outcome from the queued follow-up batch. Throws
   * on hard failure. Omitted by strategies whose first (and only) turn is
   * always terminal (a background script); the loop never calls `runTurn` in
   * that case. Native children keep their own input wait inside `launch`.
   */
  runTurn?(
    followUps: readonly FollowUpContent[],
    ports: ChildRunPorts,
    signal: AbortSignal,
  ): Effect.Effect<TTurn, Error, R>;

  /** True when `turn` ends this child's run; no further turns follow. */
  isTerminal(turn: TTurn): boolean;

  /** Token usage for the turn summary (null when none). */
  getUsage?(turn: TTurn): TokenUsageStats | null;

  /**
   * Application-level error reported by a turn that did NOT throw (e.g. the SDK
   * returned an error result). Omit for providers that always throw on failure.
   */
  isTurnError?(turn: TTurn): boolean;
  /** An interrupted interactive turn has no new result to settle. */
  isTurnInterrupted?(turn: TTurn): boolean;

  /** The error message to log for a non-throwing failure, if it has one. */
  turnErrorMessage?(turn: TTurn): string | undefined;

  /** After a successful turn: register the session/thread id, etc. */
  onTurnSuccess?(turn: TTurn, session: SessionHandle): void;

  /** Publish token usage to the UI. */
  publishUsage?(turn: TTurn): void;

  /**
   * Format the success delivery XML. A native document-task subagent
   * reads and writes on the way (diff files land in the run directory
   * first), so this is an Effect over the same `R` the turns read; every
   * other strategy formats from what it already holds.
   */
  formatDelivery(
    turn: TTurn,
    wallTimeMs: number,
  ): Effect.Effect<string, Error, R>;

  /** Format the error delivery XML (turn is null when the call threw). */
  formatError(turn: TTurn | null, err: unknown): string;

  /**
   * Structured result manifest persisted beside each turn's report, success
   * or failure (`turn` null when the call threw), so a failure overwrites a
   * stale interim manifest. Agent-CLI strategies omit it.
   */
  buildResultMeta?(
    turn: TTurn | null,
    isError: boolean,
    wallTimeMs: number,
    /**
     * The thrown error of a failed turn, when the failure was a throw rather
     * than a returned failed result; so the manifest can carry the failure
     * message even when no flow result exists to carry it.
     */
    error?: unknown,
  ): Effect.Effect<DeliveredResult | undefined, Error, R>;

  /**
   * Release provider-owned registry entries. The loop calls this exactly once,
   * before failed/interrupted parent delivery or during finalization.
   */
  releaseSessionOwnership?(): void;
}

export interface ChildRunLoopParams<TTurn, R = never> {
  readonly session: SessionHandle;
  /**
   * Presentation and finalization port for process-backed children (agent
   * CLIs, background bash). Native engines finalize their
   * own run handle.
   */
  readonly childRun?: ChildRunPort;
  readonly parentRunId: RunId;
  /** The child's run id: what the loop reads its input and attaches its
   *  interrupt handler under. */
  readonly runId: RunId;
  readonly agentName: string;
  readonly strategy: ChildRunStrategy<TTurn, R>;
  /**
   * Gate every turn through the session's child-run budget semaphore
   * (`RunRegistry.childRunBudget`); agent-CLI children, external processes,
   * sit outside it (`.agents/docs/implemented/architecture/2026-08-15-child-run-concurrency-budget.md`).
   */
  readonly budgeted: boolean;
  /**
   * Progress sink override for awaiting callers of a persist-only child: the
   * parent is blocked inside a tool call, so follow-up delivery cannot reach
   * it and the caller degrades deliberately (e.g. to the parent run's trace).
   * When present it replaces follow-up delivery for every progress update.
   */
  readonly notify?: (update: SubagentProgressUpdate) => void;
  /**
   * Hands an awaiting caller each settled turn's facts in memory, once per
   * settled turn after persistence; a required-durability caller verifies
   * the store afterwards rather than changing what the loop persists.
   */
  readonly onTurnSettled?: (settled: {
    readonly message: string;
    readonly resultMeta?: DeliveredResult;
    readonly isError: boolean;
    readonly error?: unknown;
  }) => void;
}

/**
 * One child loop's state, passed through the functions below; nothing else
 * holds a copy: the setup (unwound once if the run never takes it over),
 * the turn the loop is on, and `ending`, the settlement its end writes. Its
 * stop sits on the run's registry activation for the loop's whole life. A
 * process child's turns hear it through `signal` alone and its loop fiber
 * survives it to deliver and finalize (rulings ledger 2026-08-01); a native
 * child's turn is this session's own run program, so its stop also
 * interrupts the run fiber.
 */
class ChildLoop<TTurn, R> {
  private readonly controller = new AbortController();
  /** The stop was a user's, read when it lands: the registry forgets the
   *  reason once the run has unwound. */
  userStopped = false;
  readonly trace: AgentTrace | undefined;
  /** The parent edge, the run registry's shared cell: a detach severs it. */
  readonly parent: RunParent;
  readonly attemptId = randomUUID();
  stage: StageHandle | undefined;
  budget: Semaphore.Semaphore | undefined;
  releaseActivation: () => void = () => undefined;
  /** Releases the claim the child holds for its whole life: its birth
   *  claim, or one taken over from a prior owner proved dead. */
  releaseClaim: Effect.Effect<void> = Effect.void;
  ownershipReleased = false;
  /** Setup compensated; settlement handed to the run fiber; it started. */
  unwound = false;
  forked = false;
  started = false;
  turnIndex = 0;
  turnStart = 0;
  /** The follow-ups the current turn's prompt took. */
  consumed: readonly QueuedFollowUp[] = [];
  failed = false;
  lastError: unknown;
  ending: ChildSettlement | undefined;
  ended = false; // a native run's own `run.end` carried `ending`
  endReport: Effect.Effect<void> = Effect.void;
  endFailure: Error | undefined;

  constructor(
    readonly params: ChildRunLoopParams<TTurn, R>,
    readonly runs: RunRegistry,
  ) {
    this.trace = params.childRun?.logger;
    this.parent = runs.getHandle(params.runId)?.parentState ?? {
      current: params.parentRunId,
    };
  }

  interrupt(): void {
    const { runId, childRun } = this.params;
    this.userStopped ||= this.runs.stopReason(runId) === 'user';
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
    this.params.strategy.releaseSessionOwnership?.();
  }

  /** One loop diagnostic: on an agent-CLI child's own trace; every other
   *  child has no loop-owned stream, so on the process log. */
  log(
    level: keyof typeof EFFECT_LOG,
    message: string,
    data?: unknown,
  ): Effect.Effect<void> {
    const trace = this.trace;
    if (trace)
      return Effect.sync(() =>
        trace[level](message, data === undefined ? undefined : { data }),
      );
    const entry = EFFECT_LOG[level](message).pipe(withLogChannel(CHANNEL));
    return data === undefined ? entry : Effect.annotateLogs(entry, { data });
  }
}

const CHANNEL = 'childRunLoop';
const SLOT_CANCELLED =
  'Child run turn cancelled while awaiting a concurrency slot.';

const EFFECT_LOG = {
  debug: Effect.logDebug,
  info: Effect.logInfo,
  warn: Effect.logWarning,
  error: Effect.logError,
} as const;

/** Outcome of a single turn attempt, flattening the loop's inner try/catch. */
type TurnAttempt<TTurn> =
  | { kind: 'completed'; turn: TTurn; turnIsError: boolean }
  | { kind: 'failed'; err: unknown }
  | { kind: 'interrupted' };

/**
 * Run one turn (via `runner`) and classify the outcome. A clean interruption
 * maps to `interrupted` (the caller breaks), a thrown call to `failed`, and a
 * returned turn to `completed` (carrying its application-level error flag).
 * A native run's exit is classified the same way: joined, its failure is the
 * failed turn a thrown call is.
 */
function attemptTurn<TTurn, R, RTurn>(
  loop: ChildLoop<TTurn, R>,
  runner: (signal: AbortSignal) => Effect.Effect<TTurn, Error, RTurn>,
): Effect.Effect<TurnAttempt<TTurn>, never, RTurn> {
  const { strategy } = loop.params;
  const startedAt = loop.turnStart;
  return Effect.gen(function* () {
    const attempt = yield* Effect.exit(
      Effect.gen(function* () {
        const turn = yield* runner(loop.signal);
        // The turn summary (duration + token usage) on the child stream.
        const wallTimeMs = (yield* Clock.currentTimeMillis) - startedAt;
        yield* loop.log(
          'info',
          `Turn completed in ${formatDuration(wallTimeMs)}`,
        );
        const usage = strategy.getUsage?.(turn);
        if (usage) {
          yield* loop.log('info', 'Tokens', {
            input: usage.inputTokens,
            output: usage.outputTokens,
          });
        }
        const turnIsError = strategy.isTurnError?.(turn) === true;
        const turnError = turnIsError
          ? strategy.turnErrorMessage?.(turn)
          : undefined;
        if (turnError) yield* loop.log('error', turnError);
        return { kind: 'completed' as const, turn, turnIsError };
      }),
    );
    if (Exit.isSuccess(attempt)) return attempt.value;
    const caught = Cause.squash(attempt.cause);
    if (loop.isInterrupted() || isUserAbort(caught)) {
      return { kind: 'interrupted' as const };
    }
    yield* loop.log('error', toErrorMessage(caught));
    return { kind: 'failed' as const, err: caught };
  });
}

/**
 * A process child's phase across its park (one run model, 3.3): `parked`
 * before the loop blocks on its queue, `resumed` when the taken batch starts
 * the next turn. Without it the idle run stays RUNNING and the next
 * submission classifies as `no_session`; native children park through their
 * own loop's `waiting` step, so each park keeps one writer.
 */
const parkRow = (runId: RunId, phase: 'parked' | 'resumed') =>
  ({
    type: 'child.park',
    aggregateId: qualifyAggregateId('run', runId),
    phase,
  }) as const;

/** Progress reaches the parent as queued follow-ups, enqueued on the
 *  session's publisher where it is reported, so each commits ahead of the
 *  turn's result. */
const progressPorts = <TTurn, R>(loop: ChildLoop<TTurn, R>): ChildRunPorts => ({
  notify: (update) => {
    const { notify, strategy, session, runId, agentName } = loop.params;
    if (notify) return notify(update);
    const target = loop.parent.current;
    if (strategy.deliveryMode === 'persistOnly' || target === null) return;
    // Nothing is queued when no session holds the run.
    if (session.runs.getToolUseFollowUpTarget(target).kind === 'no_session')
      return;
    session.followUps.sendDetached(target, {
      text: formatSubagentProgress(runId, agentName, update),
      from: { kind: 'run', runId },
    });
  },
});

/** Unwind what the setup acquired, once, before the run took it over. */
const unwindSetup = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  error: unknown,
): Effect.Effect<Error> =>
  Effect.gen(function* () {
    loop.unwound = true;
    const cleanupErrors: unknown[] = [];
    const cleanups = [
      () => loop.stage?.end(RUN_OUTCOME.FAILED),
      loop.releaseActivation,
      () => loop.releaseOwnership(),
    ];
    for (const cleanup of cleanups) {
      const result = yield* Effect.exit(Effect.sync(cleanup));
      if (Exit.isFailure(result))
        cleanupErrors.push(Cause.squash(result.cause));
    }
    return ensureError(
      aggregateError(
        [error, ...cleanupErrors],
        `Child run ${loop.params.runId} setup failed and rollback was incomplete`,
      ),
    );
  });

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
 *  persist-only, detached, or stopped with nothing to deliver. */
const deliveryTarget = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  turn: TTurn | null,
  isError: boolean,
): Effect.Effect<RunId | null> =>
  Effect.gen(function* () {
    const { strategy, session, runId } = loop.params;
    if (strategy.deliveryMode === 'persistOnly') return null;
    const target = loop.parent.current;
    if (target === null) {
      yield* loop.log(
        'warn',
        'Turn result not delivered: child was detached from its orchestrator. The result remains in the run report.',
        { runId },
      );
      return null;
    }
    if (loop.isInterrupted()) {
      loop.releaseOwnership();
      return strategy.deliverAfterInterrupt === true ? target : null;
    }
    if (isError) loop.releaseOwnership();
    else if (turn != null) strategy.onTurnSuccess?.(turn, session);
    return target;
  });

/** One turn's settlement, and the report an awaiting caller reads once it
 *  commits (or once its commit failed, then the turn's failure). */
type Settled = { settlement: ChildSettlement; report: Effect.Effect<void> };

const settleTurn = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  turn: TTurn | null,
  err: unknown,
  turnIsError: boolean,
  last = false,
): Effect.Effect<Settled, Error, R> =>
  Effect.gen(function* () {
    const { strategy, runId } = loop.params;
    if (loop.turnIndex === 0) yield* beginTurn(loop, false);
    const wallTimeMs = (yield* Clock.currentTimeMillis) - loop.turnStart;
    const isError = err != null || turnIsError;
    if (turn != null) strategy.publishUsage?.(turn);
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
    const settlement = settlementOf({
      runId,
      turn: { key: loop.attemptId, index: loop.turnIndex },
      message,
      resultMeta,
      consumed: loop.consumed,
      deliveryId: strategy.deliveryId,
      to: yield* deliveryTarget(loop, turn, isError),
      ...(last && { end: isError ? 'failed' : 'completed' }),
    });
    const report = Effect.sync(() =>
      loop.params.onTurnSettled?.({
        message,
        ...(resultMeta !== undefined && { resultMeta }),
        isError,
        ...(err != null && { error: err }),
      }),
    );
    return { settlement, report };
  });

/** Settle the last turn, kept for the child's end, which writes it with its
 *  `run.end`. A failure is the loop's, raised once the run is joined. */
const settleEnd = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  turn: TTurn | null,
  err: unknown,
  isError: boolean,
): Effect.Effect<TransactionPart | undefined, never, R> =>
  settleTurn(loop, turn, err, isError, true).pipe(
    Effect.map(({ settlement, report }) => {
      loop.ending = settlement;
      loop.endReport = report;
      return settleChildTurn(
        loop.params.session.followUps,
        settlement,
        loop.trace,
      );
    }),
    Effect.catch((error) =>
      Effect.sync(() => {
        loop.endFailure = error;
        return undefined;
      }),
    ),
  );

/** The turns a native run's own loop settles, on its own fiber, under the
 *  services this loop runs with. */
function nativeTurns<TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  services: Context.Context<R>,
): ChildRunTurns<TTurn> {
  const { strategy, session } = loop.params;
  return {
    turnPermit: (turn) =>
      Effect.gen(function* () {
        if (loop.isInterrupted()) return yield* Effect.interrupt;
        yield* beginTurn(loop, false);
        return yield* loop.budget ? loop.budget.withPermit(turn) : turn;
      }),
    settleBoundary: (turn) =>
      Effect.map(
        settleTurn(loop, turn, null, false),
        ({ settlement, report }) => {
          const { rows, delivery } = settlement;
          return {
            rows,
            alongside:
              delivery && deliverIn(session.followUps, delivery, loop.trace),
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
            turn,
            null,
            strategy.isTurnError?.(turn) === true,
          ).pipe(
            Effect.tap(() => Effect.sync(() => (loop.ended = true))),
            Effect.provide(services),
          ),
  };
}

/** The child loop's abort as an Effect: settles with `outcome()`, built
 *  only when `signal` aborts, and never otherwise. */
function onceAborted<A, E>(
  signal: AbortSignal,
  outcome: () => Effect.Effect<A, E>,
): Effect.Effect<A, E> {
  return Effect.callback<A, E>((resume) => {
    const detach = onAbort(signal, () => resume(outcome()));
    return Effect.sync(detach);
  });
}

/** Hold the budget's slot only while a turn runs, unmasked. A stop races the
 *  slot wait alone; an admitted turn observes the loop's signal itself. */
function gateTurn<TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  base: (signal: AbortSignal) => Effect.Effect<TTurn, Error, R>,
): (signal: AbortSignal) => Effect.Effect<TTurn, Error, R> {
  const budget = loop.budget;
  if (budget === undefined) return base;
  return (signal) => {
    let admitted = false;
    return Effect.raceFirst(
      budget.withPermit(
        Effect.suspend(() => ((admitted = true), base(signal))),
      ),
      onceAborted(signal, () =>
        admitted ? Effect.never : Effect.fail(new Error(SLOT_CANCELLED)),
      ),
    );
  };
}

/**
 * A process child's interim turn, in one transaction: its settlement, its
 * parent's delivery and, unless a stop landed, the `parked` row, durable
 * before the loop blocks so a follow-up arriving while it sleeps is
 * admitted onto its queue instead of refused against a run that only looks
 * busy. Then the report, and the parent's wake.
 */
const settleInterim = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  turn: TTurn | null,
  err: unknown,
  turnIsError: boolean,
): Effect.Effect<void, Error, R> =>
  Effect.gen(function* () {
    const { session, runId } = loop.params;
    const settled = yield* settleTurn(loop, turn, err, turnIsError);
    const { settlement } = settled;
    const park = loop.isInterrupted() ? undefined : parkRow(runId, 'parked');
    yield* commitPart(
      session.log,
      settleChildTurn(session.followUps, settlement, loop.trace, park),
    );
    yield* settled.report;
    yield* wakeParent(session, settlement.delivery, loop.trace);
  });

/**
 * Drive the child's turns: a native launch runs on its own fiber and offers
 * its turn boundaries through `nativeTurns`; a process strategy returns a
 * turn, which settles here before the loop waits on `input` for its next
 * batch (raced against the loop's stop).
 */
const driveTurns = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  input: RunInput | null,
): Effect.Effect<TTurn | undefined, Error, R> =>
  Effect.gen(function* () {
    const { strategy, session, runId } = loop.params;
    const ports = progressPorts(loop);
    const turns = nativeTurns(loop, yield* Effect.context<R>());
    loop.turnStart = yield* Clock.currentTimeMillis;
    let runner = (signal: AbortSignal) => strategy.launch(ports, signal, turns);
    let result: TTurn | undefined;
    let resumed = false;
    while (!loop.isInterrupted()) {
      if (!strategy.continuous) yield* beginTurn(loop, resumed);
      // A native run takes its permit per turn (`turnPermit`).
      const attempt = yield* attemptTurn(
        loop,
        strategy.continuous ? runner : gateTurn(loop, runner),
      );
      if (attempt.kind === 'interrupted') break;
      const turn = attempt.kind === 'completed' ? attempt.turn : null;
      if (turn !== null) result = turn;
      if (turn !== null && strategy.isTurnInterrupted?.(turn)) {
        loop.interrupt();
        break;
      }
      const err = attempt.kind === 'failed' ? attempt.err : null;
      const turnIsError = attempt.kind === 'completed' && attempt.turnIsError;
      // A launch failure can terminate before its first model cycle.
      if (
        loop.turnIndex === 0 &&
        err != null &&
        !(yield* session.log.owns(runId))
      )
        return yield* Effect.fail(ensureError(err));
      if (err != null || turnIsError) {
        loop.failed = true;
        loop.lastError =
          err ??
          new Error(
            `${strategy.stageLabel} reported a failed turn without throwing.`,
          );
      }
      const nextRunTurn = strategy.runTurn;
      if (
        loop.failed ||
        turn == null ||
        strategy.isTerminal(turn) ||
        !nextRunTurn
      ) {
        // A native run's own `run.end` already carried it.
        if (loop.ending === undefined && loop.endFailure === undefined)
          yield* settleEnd(loop, turn, err, turnIsError);
        if (loop.endFailure !== undefined)
          return yield* Effect.fail(loop.endFailure);
        break;
      }
      yield* settleInterim(loop, turn, err, turnIsError);
      const batch =
        input === null || loop.isInterrupted()
          ? null
          : yield* Effect.raceFirst(
              input.take,
              onceAborted(loop.signal, () => Effect.succeed(null)),
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
      runner = (signal) => nextRunTurn(prompts, ports, signal);
    }
    return result;
  });

/**
 * A native child's end outside its lifecycle, which is its one terminal
 * writer and has exited by now: a failure or stop can precede it (an end it
 * wrote stands), and a launch that returned its last turn with no lifecycle
 * to settle it settles it alone. A user's stop, not a shutdown, then queues
 * what the child left for its parent to resume, read with its next input.
 */
const endNative = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  outcome: RunOutcome,
  stopped: boolean,
  settlement: TransactionPart | undefined,
): Effect.Effect<void, Error, R | Runs> =>
  Effect.gen(function* () {
    const { strategy, session, runId } = loop.params;
    const abnormal = stopped || loop.failed;
    if (abnormal && (yield* session.log.owns(runId)))
      yield* endRunOutsideLifecycle(
        session,
        runId,
        outcome,
        loop.lastError,
        settlement,
      );
    else if (!abnormal && settlement !== undefined)
      yield* commitPart(session.log, settlement);
    const target = loop.parent.current;
    if (
      strategy.stopNotice === undefined ||
      strategy.deliveryMode === 'persistOnly' ||
      !loop.userStopped ||
      target === null
    )
      return;
    // A notice that cannot be read still says the child stopped: the stop
    // stands, and the failure is loud.
    const text = yield* strategy.stopNotice().pipe(
      Effect.catch((error) =>
        loop
          .log('warn', 'Child-run stop notice failed', {
            runId,
            error,
          })
          .pipe(
            Effect.as(
              `Run ${runId} was stopped. What it had done could not be read: ${toErrorMessage(error)}`,
            ),
          ),
      ),
    );
    yield* session.followUps.send(
      target,
      {
        text,
        from: { kind: 'run', runId },
        deliveryId: `${runId}:${loop.attemptId}:stopped`,
      },
      { hold: 'instruction' },
    );
  });

/** The child's terminal row, its process port's finalize or a native run's
 *  end, carrying the last turn's settlement. */
const writeEnd = <TTurn, R>(
  loop: ChildLoop<TTurn, R>,
  stopped: boolean,
): Effect.Effect<void, Error, R | Runs> => {
  const { strategy, childRun, session } = loop.params;
  // Re-read: a stop landing after the body's exit is still the run's
  // terminal verdict.
  const stoppedAtExit = stopped || loop.isInterrupted();
  const outcome = deriveRunOutcome({
    failed: loop.failed,
    cancelled: stoppedAtExit,
  });
  const settlement =
    loop.ended || loop.ending === undefined
      ? undefined
      : settleChildTurn(session.followUps, loop.ending, loop.trace);
  if (childRun === undefined)
    return endNative(loop, outcome, stoppedAtExit, settlement);
  return childRun.finalize({
    settlement,
    outcome,
    error: loop.lastError,
    stopped: stoppedAtExit,
    stage: loop.stage,
    // A persist-only child routes nothing to a parent, so nobody could
    // continue it: its stop cancels it.
    ...(strategy.deliveryMode !== 'persistOnly' && {
      pauseNotice: strategy.pauseNotice,
    }),
  });
};

/**
 * The loop's terminal, in the toolUse exit-protocol pattern: a stop lands
 * before it or after it, never inside, so the queue lease, the terminal row,
 * the claim release and the parent's wake settle atomically on every exit.
 * The body's own failure or interruption propagates past it as itself; only
 * the cleanup's failures join it.
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
        loop.failed = true;
        loop.lastError ??= error;
        // A lost aggregate claim: this process no longer owns the run, so
        // the loop stops rather than continue under it.
        if (error instanceof DatabaseNotOwner) loop.interrupt();
      }
      // Debug-only driver diagnostic (#9531): how the loop ended.
      yield* loop.log('debug', 'childRunLoop loop.terminated', {
        runId: loop.params.runId,
        stopped,
        failed: loop.failed,
      });
      // The last turn's facts reach an awaiting caller before the child
      // ends, as every earlier turn's did.
      yield* loop.endReport;
      const terminal = yield* Effect.exit(writeEnd(loop, stopped));
      // Provider ids stay reserved until the terminal (or pause) row is
      // written, so a call naming one finds this run, not a gap.
      const owned = yield* Effect.exit(
        Effect.sync(() => loop.releaseOwnership()),
      );
      // The parent may immediately read this child; release its claim first.
      yield* loop.releaseClaim;
      const wake = yield* Effect.exit(
        wakeParent(loop.params.session, loop.ending?.delivery, loop.trace),
      );
      const activation = yield* Effect.exit(
        Effect.sync(loop.releaseActivation),
      );
      const failures = [terminal, owned, wake, activation].flatMap((exit) =>
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
    const { session, runId, strategy } = loop.params;
    loop.started = true;
    const claimHeld = yield* Scope.make();
    yield* session.log.hold(runId, { ends: true }).pipe(
      Scope.provide(claimHeld),
      Effect.onError(() => Scope.close(claimHeld, Exit.void)),
    );
    loop.releaseClaim = Scope.close(claimHeld, Exit.void);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        // A native child's own loop opens its reader, as any run's loop does.
        if (strategy.continuous) return yield* driveTurns(loop, null);
        const reader = yield* session.followUps.open(runId);
        // Its end is the child's: it takes no more input here.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => session.followUps.release(runId, reader, true)),
        );
        return yield* driveTurns(loop, reader);
      }),
    );
  }).pipe(Effect.onExit((body) => endChildLoop(loop, body)));

/**
 * Reserve the child's stop target, budget and stage, then launch its run.
 * The launched fiber owns settlement from its first step; an unwind before
 * that still owns the setup it acquired. It is admitted a tick later, once
 * this launch has handed back its fiber.
 */
const launchChildLoop = <TTurn, R extends AgentRunServices>(
  loop: ChildLoop<TTurn, R>,
): Effect.Effect<Fiber.Fiber<TTurn | undefined, Error>, Error, R | Runs> =>
  Effect.gen(function* () {
    const { childRun, session, runId, strategy, budgeted } = loop.params;
    // Every child loop reserves its stop target for its whole life; only a
    // native one retains a terminal parent's continuation.
    loop.releaseActivation = loop.runs.reserveChildActivation({
      runId,
      parent: loop.parent,
      retainsTerminalParent: childRun === undefined,
      interrupt: () => loop.interrupt(),
    });
    // Read after the reservation, so no stop lands while there is no target.
    if (budgeted)
      loop.budget = yield* loop.runs.childRunBudget(
        yield* resolveChildRunConcurrencyBudget(session.roots),
      );
    const setup = yield* Effect.exit(
      Effect.sync(() => {
        // A stop sees the handle only from here, with its target reserved.
        childRun?.track();
        loop.stage = loop.trace?.openStage(strategy.stageLabel);
      }),
    );
    if (Exit.isFailure(setup))
      return yield* Effect.fail(
        yield* unwindSetup(loop, Cause.squash(setup.cause)),
      );
    return yield* loop.runs.launch(runId, runChildLoop(loop), (admitted) =>
      Effect.suspend(() => {
        loop.forked = true;
        return Effect.andThen(Effect.yieldNow, admitted).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.gen(function* () {
                  const error = loop.started
                    ? ensureError(Cause.squash(cause))
                    : yield* unwindSetup(loop, Cause.squash(cause));
                  return yield* Effect.fail(error);
                }),
          ),
        );
      }),
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
    const loop = new ChildLoop(params, runs);
    // The handoff never happened: the setup this launch acquired unwinds
    // here, atomically, rather than leaking the activation and the stage.
    return launchChildLoop(loop).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) || loop.forked || loop.unwound
          ? Effect.void
          : Effect.uninterruptible(
              Effect.flatMap(
                unwindSetup(loop, Cause.squash(exit.cause)),
                Effect.fail,
              ),
            ),
      ),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.fail(ensureError(Cause.squash(cause))),
    ),
  );
}
