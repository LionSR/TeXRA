import { randomUUID } from 'node:crypto';
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Queue } from 'effect';

// Shared child accounting and durable delivery for native runs and processes.

import type { AgentTrace, StageHandle } from '@agent/trace';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { resolveChildRunConcurrencyBudget } from '@agent/runtime/childRunBudget';
import type { RunParent } from '@agent/runtime/RunHandle';
import {
  Runs,
  type AgentRunServices,
  type RunRegistry,
} from '@agent/runtime/runRegistry';
import { endRunOutsideLifecycle } from '@agent/runtime/runLaunchGuard';
import type { RunInput } from '@agent/followUp/RunInput';
import type { InboxItem } from '@agent/followUp/Inbox';
import {
  startFollowUpWake,
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import { persistChildRunDelivery } from '@agent/storage/childRunDeliveryPersistence';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import { withLogChannel } from '@logger/effectLog';
import {
  RUN_OUTCOME,
  aggregateId,
  type FollowUpContent,
  type DeliveredResult,
  type RunId,
  type RunOutcome,
  type SubagentProgressUpdate,
  type TokenUsageStats,
} from '@shared/schemas';
import type { AttemptKey } from '@shared/session/attemptFold';
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
 * child holds no slot); each completed turn is offered to the loop, delivered
 * on the loop's fiber, and a failed delivery is the run's failure.
 */
export interface ChildRunTurns<TTurn> {
  turnPermit<A, E, R>(
    turn: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Error, R>;
  onTurnBoundary(turn: TTurn): Effect.Effect<void, Error>;
}

export interface ChildRunStrategy<TTurn, R = never> {
  /** A native program owns its input wait and offers each turn boundary. */
  readonly continuous?: true;
  /** Stage label opened on the child trace (e.g. "Codex session"). */
  readonly stageLabel: string;

  /**
   * This child's turns drive a live OS process (a background bash command,
   * an agent-CLI provider): shutdown drain reaches it through
   * `RunHandle.backgroundProcess` (#8155) without disturbing native agent
   * children left running for restart recovery.
   */
  readonly ownsBackgroundProcess?: boolean;

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
   * Format the success delivery XML. A native workflow-category subagent
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
 * The child loop's stop, on the run's run registry activation for the loop's whole
 * life, so a stop finds a target in the inter-turn gap too. A process child's
 * turns are reached through `signal` alone (`execa`'s `cancelSignal`, the
 * Codex and Claude Agent SDKs) and its loop fiber survives the abort to
 * deliver and finalize (rulings ledger 2026-08-01). A native child's turn is
 * this session's own run program, so its stop also interrupts the run fiber.
 */
class ChildRunInterruptible {
  private readonly controller = new AbortController();

  constructor(
    private readonly runs: RunRegistry,
    private readonly runId: RunId,
    /** A native child's turns run on the run's fiber; a process child's loop
     *  fiber must survive the stop to deliver and finalize. */
    private readonly interruptsRunFiber: boolean,
  ) {}

  /** The stop was a user's, read when it lands: the registry forgets the
   *  reason once the run has unwound. */
  private stoppedByUser = false;

  interrupt(): void {
    this.stoppedByUser ||= this.runs.stopReason(this.runId) === 'user';
    this.controller.abort();
    if (this.interruptsRunFiber) this.runs.interrupt(this.runId);
  }

  get userStopped(): boolean {
    return this.stoppedByUser;
  }

  isInterrupted(): boolean {
    return this.controller.signal.aborted;
  }

  /** The one cancellation signal every turn of this child runs under: no
   *  turn starts after an interrupt, so a per-turn one would mirror it. */
  get signal(): AbortSignal {
    return this.controller.signal;
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

/**
 * Write one loop diagnostic. An agent-CLI child presents them on its own
 * trace; every other child has no loop-owned stream, so they go to the
 * process log under this module's channel.
 */
function loopLog(
  trace: AgentTrace | undefined,
  level: keyof typeof EFFECT_LOG,
  message: string,
  data?: unknown,
): Effect.Effect<void> {
  if (trace) {
    return Effect.sync(() =>
      trace[level](message, data === undefined ? undefined : { data }),
    );
  }
  const entry = EFFECT_LOG[level](message).pipe(withLogChannel(CHANNEL));
  return data === undefined ? entry : Effect.annotateLogs(entry, { data });
}

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
  strategy: ChildRunStrategy<TTurn, R>,
  runner: (signal: AbortSignal) => Effect.Effect<TTurn, Error, RTurn>,
  loop: ChildRunInterruptible,
  trace: AgentTrace | undefined,
  startedAt: number,
): Effect.Effect<TurnAttempt<TTurn>, never, RTurn> {
  return Effect.gen(function* () {
    const attempt = yield* Effect.exit(
      Effect.gen(function* () {
        const turn = yield* runner(loop.signal);
        // The turn summary (duration + token usage) on the child stream.
        const wallTimeMs = (yield* Clock.currentTimeMillis) - startedAt;
        yield* loopLog(
          trace,
          'info',
          `Turn completed in ${formatDuration(wallTimeMs)}`,
        );
        const usage = strategy.getUsage?.(turn);
        if (usage) {
          yield* loopLog(trace, 'info', 'Tokens', {
            input: usage.inputTokens,
            output: usage.outputTokens,
          });
        }
        const turnIsError = strategy.isTurnError?.(turn) === true;
        const turnError = turnIsError
          ? strategy.turnErrorMessage?.(turn)
          : undefined;
        if (turnError) yield* loopLog(trace, 'error', turnError);
        return { kind: 'completed' as const, turn, turnIsError };
      }),
    );
    if (Exit.isSuccess(attempt)) return attempt.value;
    const caught = Cause.squash(attempt.cause);
    if (loop.isInterrupted() || isUserAbort(caught)) {
      return { kind: 'interrupted' as const };
    }
    yield* loopLog(trace, 'error', toErrorMessage(caught));
    return { kind: 'failed' as const, err: caught };
  });
}

/**
 * The delivery id one accepted turn's single parent delivery is admitted
 * under (#9531). A turn that ran queued follow-ups takes its identity from
 * the prompt's durable rows, so a crash between parent admission and prompt
 * consumption re-executes under a new attempt id yet is judged a replay.
 * Every other turn takes the `child.turn` row's key (run, attempt, turn
 * index), distinct across attempts even when a workflow reuses its run id.
 */
function turnDeliveryId(
  runId: RunId,
  turn: AttemptKey,
  consumed: readonly QueuedFollowUp[],
): string {
  const prompt = consumed[0]?.followUpId;
  if (prompt !== undefined) return `${runId}:${prompt}:delivery`;
  return `${runId}:${turn.key}:${turn.index}:delivery`;
}

type ChildLoopTerminationCause = 'interrupted' | 'turn_failed' | 'terminal';

/**
 * Commit one turn's `child.turn` row (#9531), the fact the report/result
 * slots are attributed from. Not best-effort: a refused append is the turn's
 * failure, and `not-owner` stops the loop rather than deliver under a lost
 * claim (R7). An agent-CLI turn's settlement also consumes the follow-ups
 * that were its prompt (C3); the parent delivery is admitted first, so a
 * crash either way leaves the parent exactly one result. A turn whose own
 * persistence failed consumes nothing, so its prompt stays queued.
 */
function commitChildTurn(
  session: SessionHandle,
  runId: RunId,
  turn: AttemptKey,
  phase: 'accepted' | 'settled',
  consumed: readonly QueuedFollowUp[] = [],
): Effect.Effect<void, DatabaseNotOwner | DatabaseWriteFailed> {
  return session
    .commit([
      ...consumed.map((followUp) => ({
        type: 'followup.consumed' as const,
        aggregateId: aggregateId('run', runId),
        followUpId: followUp.followUpId,
      })),
      {
        type: 'child.turn',
        aggregateId: aggregateId('run', runId),
        attemptId: turn.key,
        turnIndex: turn.index,
        phase,
      },
    ])
    .pipe(Effect.asVoid);
}

/**
 * Move an agent-CLI child's phase across its park (one run model, 3.3):
 * `parked` before the loop blocks on its queue, `resumed` when the taken
 * batch starts the next turn. Without it the idle run stays RUNNING and the
 * next submission classifies as `no_session`; native children park through
 * their own loop's `waiting` step, so each park keeps one writer.
 */
function commitPark(
  session: SessionHandle,
  runId: RunId,
  phase: 'parked' | 'resumed',
): Effect.Effect<void, DatabaseNotOwner | DatabaseWriteFailed> {
  return session
    .commit([
      { type: 'child.park', aggregateId: aggregateId('run', runId), phase },
    ])
    .pipe(Effect.asVoid);
}

/**
 * A turn's parent-follow-up enqueue, still pending its wake step. Waking can
 * await the resumed parent's entire turn (`resumeOnSession` → …
 * → `resumeToolUseFromResumeData`), so callers that are about to finalize this
 * child (terminal/failed turns) must resolve the wake only AFTER that
 * finalize completes; otherwise a resumed parent that immediately waits on
 * this still-RUNNING run self-stalls (#8093). Callers that continue to
 * another turn (no finalize pending) may wake immediately.
 */
interface PendingChildDelivery {
  readonly parent: RunParent;
  readonly followUp: InboxItem;
  /**
   * The parent follow-up row is already durable. `wake` means this process
   * still has to wake the parent after this child's finalize; a parent live
   * here reads the held row once this child's terminal row folds.
   */
  readonly wake?: true;
}

/**
 * A turn result with nowhere to go: the child detached from its orchestrator,
 * so the report slot is the only place the outcome survives. Shared by the
 * enqueue site and the deferred wake site, which resolve the target at
 * different times.
 */
const warnDetachedChildDelivery = (
  trace: AgentTrace | undefined,
  runId: RunId,
): Effect.Effect<void> =>
  loopLog(
    trace,
    'warn',
    'Turn result not delivered: child was detached from its orchestrator. The result remains in the run report.',
    { runId },
  );

/**
 * Format, persist, and enqueue one turn's outcome on the parent's follow-up
 * queue; the loop's single delivery site, shared by every interim and
 * terminal turn, every strategy. Returns the pending delivery for the caller
 * to wake via {@link submitPendingDelivery} once its own ordering allows it;
 * `undefined` when there is nothing to wake (detached child, or delivery
 * skipped by `prepareParentDelivery`).
 */
const deliverTurn = Effect.fn('childRunLoop.deliverTurn')(function* <
  TTurn,
  R,
>(params: {
  session: SessionHandle;
  strategy: ChildRunStrategy<TTurn, R>;
  runId: RunId;
  trace: AgentTrace | undefined;
  turn: TTurn | null;
  turnKey: AttemptKey;
  /** The queued follow-ups this turn ran as its prompt. */
  consumed: readonly QueuedFollowUp[];
  err: unknown;
  wallTimeMs: number;
  isError: boolean;
  finalizing: boolean;
  prepareParentDelivery?: () => boolean;
  parent: RunParent;
  onTurnSettled?: ChildRunLoopParams<TTurn>['onTurnSettled'];
}): Effect.fn.Return<PendingChildDelivery | undefined, Error, R> {
  const {
    strategy,
    runId,
    trace,
    turn,
    turnKey,
    err,
    wallTimeMs,
    isError,
    prepareParentDelivery,
    parent,
  } = params;
  const delivered = turn != null && !isError;
  const msg = delivered
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
  // The settled facts reach the caller whether or not they persisted: a
  // durable caller decides from them what a missing manifest means. The
  // persistence failure is then this turn's failure, thrown once the turn
  // is settled, and the delivery never reaches the parent.
  const persisted = yield* Effect.exit(
    persistChildRunDelivery(params.session, runId, msg, resultMeta),
  );
  const followUp: InboxItem = {
    text: msg,
    from: { kind: 'run', runId },
    deliveryId:
      strategy.deliveryId ?? turnDeliveryId(runId, turnKey, params.consumed),
  };
  let pending: PendingChildDelivery | undefined;
  if (Exit.isSuccess(persisted) && strategy.deliveryMode !== 'persistOnly') {
    const targetRunId = parent.current ?? undefined;
    if (!targetRunId) {
      yield* warnDetachedChildDelivery(trace, runId);
    } else if (prepareParentDelivery?.() !== false) {
      // Admit the parent row before consuming the prompt: a crash after
      // settlement then still leaves the result on the parent, and a crash
      // before it re-executes the prompt under the same delivery id, which
      // admission judges a replay. A turn this loop finalizes after
      // (failed, terminal, or a strategy with no next turn) holds the row
      // until this child has ended, so a live parent cannot take it and
      // wait on a child that still reports RUNNING (#8093); the wake
      // waits for that finalize too (submitPendingDelivery).
      const submitted = yield* params.session.followUps.send(
        targetRunId,
        followUp,
        { wake: true, ...(params.finalizing ? { hold: 'senderEnd' } : {}) },
      );
      if (submitted.kind === 'refused') {
        yield* loopLog(
          trace,
          'warn',
          `Turn result not delivered: parent run is unavailable (${submitted.reason ?? 'not_resumable'}). The result remains in the run report.`,
          { runId, parentRunId: targetRunId, reason: submitted.reason },
        );
      } else {
        pending = {
          parent,
          followUp,
          ...(submitted.kind === 'queued' && submitted.wake
            ? { wake: submitted.wake }
            : {}),
        };
      }
    }
  }
  // The turn settled whatever persistence did, and a recovering caller's
  // re-execution gate reads that settled row, so it lands before the
  // failure is raised. The prompt is consumed only when its result is
  // durable; otherwise it stays queued for the relaunched loop.
  yield* commitChildTurn(
    params.session,
    runId,
    turnKey,
    'settled',
    Exit.isSuccess(persisted) ? params.consumed : [],
  );

  params.onTurnSettled?.({
    message: msg,
    ...(resultMeta !== undefined && { resultMeta }),
    isError,
    ...(err != null && { error: err }),
  });
  if (Exit.isFailure(persisted))
    return yield* Effect.failCause(persisted.cause);
  return pending;
});

/**
 * Resolve a pending delivery's wake step (no-op when there is nothing to
 * wake, or the enqueue itself found no session; already logged above).
 */
const submitPendingDelivery = Effect.fn('submitPendingDelivery')(function* (
  pending: PendingChildDelivery | undefined,
  session: SessionHandle,
  runId: RunId,
  trace: AgentTrace | undefined,
): Effect.fn.Return<void, Error> {
  if (!pending) return;
  const targetRunId = pending.parent.current ?? undefined;
  if (!targetRunId) {
    yield* warnDetachedChildDelivery(trace, runId);
    return;
  }
  /** The parent could not be resumed; its result still awaits an explicit resume. */
  const warnParentNotResumed = loopLog(
    trace,
    'warn',
    'Turn result queued for the parent, but the parent could not be resumed; an explicit Resume delivers it.',
    { runId, parentRunId: targetRunId },
  );
  if (pending.wake) {
    const resumed = yield* startFollowUpWake(targetRunId, session);
    if (!resumed) yield* warnParentNotResumed;
  }
  // Duplicate-safe: the parent row was admitted before the child prompt
  // was consumed. This wake still goes through submitFollowUp so a mocked
  // delivery site (and a live parent that needs no wake) still sees it at
  // the original post-finalize point.
  const delivery = yield* submitFollowUp(targetRunId, pending.followUp, {
    session,
  });
  if (delivery.status === 'failed') {
    yield* loopLog(
      trace,
      'warn',
      `Turn result not delivered: parent run is unavailable (${delivery.reason}). The result remains in the run report.`,
      { runId, parentRunId: targetRunId, reason: delivery.reason },
    );
  } else if (delivery.status === 'queued' && delivery.wake === 'failed') {
    yield* warnParentNotResumed;
  }
});

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

/**
 * Own one child's delivery, queue, concurrency budget and terminal cleanup.
 * A native launch runs on its own fiber and offers its turn boundaries to
 * this loop; process strategies return a turn and wait for their next batch
 * here.
 */
export function startChildRunLoop<TTurn, R extends AgentRunServices = never>(
  params: ChildRunLoopParams<TTurn, R>,
): Effect.Effect<Fiber.Fiber<TTurn | undefined, Error>, Error, R | Runs> {
  const runSession = params.session;
  const runId = params.runId;
  // The launch's unwind bookkeeping lives beside the generator, not inside
  // it: the `onExit` chained after it runs the same compensation when the
  // launch unwinds before the fork, so these stay in its scope.
  let sessionStage: StageHandle | undefined;
  let releaseChildActivation: () => void = () => undefined;
  let releaseSessionOwnershipOnce: () => void = () => undefined;
  // Set once the setup's compensation has run (either early-fail path or
  // the launch's exit finalizer), so it never runs twice.
  let setupUnwound = false;
  // Set once the fork has handed settlement to the daemon; an unwind of the
  // launch fiber before that point still owns the setup it acquired.
  let forked = false;
  // Unwind setup and lane refusals before the run body takes ownership.
  const unwindSetup = (error: unknown): Effect.Effect<Error> =>
    Effect.suspend(() => {
      setupUnwound = true;
      return Effect.gen(function* () {
        const cleanupErrors: unknown[] = [];
        const cleanups = [
          () => sessionStage?.end(RUN_OUTCOME.FAILED),
          releaseChildActivation,
          releaseSessionOwnershipOnce,
        ];
        for (const cleanup of cleanups) {
          const result = yield* Effect.exit(Effect.sync(cleanup));
          if (Exit.isFailure(result))
            cleanupErrors.push(Cause.squash(result.cause));
        }
        return ensureError(
          aggregateError(
            [error, ...cleanupErrors],
            `Child run ${runId} setup failed and rollback was incomplete`,
          ),
        );
      });
    });

  return Effect.gen(function* () {
    const runs = yield* Runs;
    const { childRun, parentRunId, agentName, strategy } = params;
    // An agent-CLI child presents on its own trace; `loopLog` sends every
    // other child's driver diagnostics to the process log.
    const trace = childRun?.logger;
    const loop = new ChildRunInterruptible(runs, runId, childRun === undefined);
    // Every child loop reserves its stop target on the run's run registry entry for
    // its whole life; only a native one retains a terminal parent's
    // continuation. The parent edge is the run registry's shared cell.
    const parent = runs.getHandle(runId)?.parentState ?? {
      current: parentRunId,
    };
    releaseChildActivation = runs.reserveChildActivation({
      runId,
      parent,
      retainsTerminalParent: childRun === undefined,
      interrupt: () => loop.interrupt(),
    });
    // Read after the reservation, so no stop lands while there is no target.
    const budget = params.budgeted
      ? yield* runs.childRunBudget(
          yield* resolveChildRunConcurrencyBudget(runSession.roots),
        )
      : undefined;
    let sessionOwnershipReleased = false;
    releaseSessionOwnershipOnce = (): void => {
      if (sessionOwnershipReleased) return;
      sessionOwnershipReleased = true;
      strategy.releaseSessionOwnership?.();
    };

    // A process child's driver reads its input; a native child's own
    // loop does (it opens its reader as any run's loop does).
    let input!: RunInput;

    const setup = yield* Effect.exit(
      Effect.sync(() => {
        // A stop sees the handle only from here, with its target reserved.
        childRun?.track();
        if (strategy.ownsBackgroundProcess === true) {
          // The one handle slot shutdown drain reads (#8155): kill the
          // leaked OS process without touching the loop that reports it.
          const handle = runs.getHandle(runId);
          if (handle) {
            handle.backgroundProcess = { kill: () => loop.interrupt() };
          }
        }
        sessionStage = trace?.openStage(strategy.stageLabel);
      }),
    );
    if (Exit.isFailure(setup)) {
      return yield* Effect.fail(yield* unwindSetup(Cause.squash(setup.cause)));
    }

    const attemptId = randomUUID();
    // Progress reaches the parent as queued follow-ups. The port is
    // synchronous, so each is enqueued on the session's publisher where it is
    // reported and commits ahead of the result row `deliverTurn` enqueues later.
    const ports: ChildRunPorts = {
      notify: (update) => {
        if (params.notify) {
          params.notify(update);
          return;
        }
        if (strategy.deliveryMode === 'persistOnly' || parent.current === null)
          return;
        const targetRunId = parent.current ?? undefined;
        if (!targetRunId) return;
        // Nothing is queued when no session holds the run.
        if (
          runSession.runs.getToolUseFollowUpTarget(targetRunId).kind !==
          'no_session'
        ) {
          runSession.followUps.sendDetached(targetRunId, {
            text: formatSubagentProgress(runId, agentName, update),
            from: { kind: 'run', runId },
          });
        }
      },
    };

    let sawTurnFailure = false;
    let lastTurnErr: unknown;
    // Terminal delivery wakes only after the child's finalization and claim
    // release. Interim delivery wakes immediately, while the child stays live.
    let pendingDelivery: PendingChildDelivery | undefined;
    // Hold the slot only while a turn runs, unmasked. A stop races the slot
    // wait alone; an admitted turn observes the loop's signal itself.
    const gateTurn = (
      base: (signal: AbortSignal) => Effect.Effect<TTurn, Error, R>,
    ): ((signal: AbortSignal) => Effect.Effect<TTurn, Error, R>) =>
      budget === undefined
        ? base
        : (signal) => {
            let admitted = false;
            return Effect.raceFirst(
              budget.withPermit(
                Effect.suspend(() => ((admitted = true), base(signal))),
              ),
              onceAborted(signal, () =>
                admitted
                  ? Effect.never
                  : Effect.fail(new Error(SLOT_CANCELLED)),
              ),
            );
          };

    let runStarted = false;
    // The loop's hold on the child's claim for the child's whole life: its
    // birth claim, or — for a recovered child — the claim taken over after
    // its prior owner is proved dead. Released once the child's ending has
    // committed and before its final delivery, which the parent may answer
    // at once by reading the child.
    let releaseClaim: Effect.Effect<void> = Effect.void;
    const run = Effect.gen(function* () {
      runStarted = true;
      releaseClaim = yield* runSession.acquireClaims(
        aggregateId('run', runId),
        {
          ends: true,
        },
      );
      let turnIndex = 0;
      let result: TTurn | undefined;
      yield* Effect.scoped(
        Effect.gen(function* () {
          if (!strategy.continuous) {
            const reader = yield* runSession.followUps.open(runId);
            input = reader;
            // Its end is the child's: it takes no more input here.
            yield* Effect.addFinalizer(() =>
              Effect.sync(() =>
                runSession.followUps.release(runId, reader, true),
              ),
            );
          }
          let consumed: readonly QueuedFollowUp[] = [];
          let turnStart = yield* Clock.currentTimeMillis;
          const beginTurn = Effect.gen(function* () {
            turnIndex += 1;
            turnStart = yield* Clock.currentTimeMillis;
            const turnKey = { key: attemptId, index: turnIndex };
            yield* commitChildTurn(runSession, runId, turnKey, 'accepted');
          });
          const settleTurn = (
            turn: TTurn | null,
            err: unknown,
            turnIsError: boolean,
            finalizing: boolean,
          ) =>
            Effect.gen(function* () {
              const turnKey = { key: attemptId, index: turnIndex };
              const wallTimeMs = (yield* Clock.currentTimeMillis) - turnStart;
              const turnFailed = err != null || turnIsError;

              if (turn != null) {
                strategy.publishUsage?.(turn);
              }

              return yield* deliverTurn({
                session: runSession,
                strategy,
                runId,
                parent,
                trace,
                turn,
                turnKey,
                consumed,
                err,
                wallTimeMs,
                isError: turnFailed,
                finalizing,
                onTurnSettled: params.onTurnSettled,
                prepareParentDelivery: () => {
                  if (!childRun && parent.current === null) return false;
                  if (loop.isInterrupted()) {
                    releaseSessionOwnershipOnce();
                    return strategy.deliverAfterInterrupt === true;
                  }
                  if (turnFailed) {
                    releaseSessionOwnershipOnce();
                  } else if (turn != null) {
                    strategy.onTurnSuccess?.(turn, runSession);
                  }
                  return true;
                },
              });
            });
          // A native run offers each completed turn here, and the loop settles
          // the offer with its delivery. The queue ends with the fiber that
          // feeds it: no wait on a boundary that can no longer come.
          const boundaries = yield* Queue.unbounded<
            { turn: TTurn; delivered: Deferred.Deferred<void, Error> },
            Cause.Done
          >();
          const turns: ChildRunTurns<TTurn> = {
            turnPermit: (turn) =>
              Effect.gen(function* () {
                if (loop.isInterrupted()) return yield* Effect.interrupt;
                yield* beginTurn;
                return yield* budget ? budget.withPermit(turn) : turn;
              }),
            onTurnBoundary: (turn) =>
              Effect.gen(function* () {
                const delivered = yield* Deferred.make<void, Error>();
                yield* Queue.offer(boundaries, { turn, delivered });
                yield* Deferred.await(delivered);
              }),
          };
          // Forked into this scope, which awaits it on every exit: its own
          // `run.end` precedes the loop's terminal; its exit is its last turn.
          const launchNative = Effect.gen(function* () {
            const runFiber = yield* Effect.forkScoped(
              strategy.launch(ports, loop.signal, turns),
              { startImmediately: true },
            );
            runFiber.addObserver(() => Queue.endUnsafe(boundaries));
            for (;;) {
              const next = yield* Queue.take(boundaries).pipe(
                Effect.catchTag('Done', () => Effect.succeed(null)),
              );
              if (next === null) return yield* Fiber.join(runFiber);
              const delivered = yield* Effect.exit(
                Effect.uninterruptible(
                  Effect.flatMap(
                    settleTurn(next.turn, null, false, false),
                    (delivery) =>
                      submitPendingDelivery(delivery, runSession, runId, trace),
                  ),
                ),
              );
              yield* Deferred.done(next.delivered, delivered);
            }
          });
          let runner: (
            signal: AbortSignal,
          ) => Effect.Effect<TTurn, Error, R> = (signal) =>
            strategy.launch(ports, signal, turns);
          while (!loop.isInterrupted()) {
            if (!strategy.continuous) yield* beginTurn;
            const attempt = yield* attemptTurn(
              strategy,
              strategy.continuous ? () => launchNative : gateTurn(runner),
              loop,
              trace,
              turnStart,
            );
            if (attempt.kind === 'interrupted') break;
            const turn = attempt.kind === 'completed' ? attempt.turn : null;
            if (turn !== null) result = turn;
            if (turn !== null && strategy.isTurnInterrupted?.(turn)) {
              loop.interrupt();
              break;
            }
            const err = attempt.kind === 'failed' ? attempt.err : null;
            const turnIsError =
              attempt.kind === 'completed' && attempt.turnIsError;
            const turnFailed = err != null || turnIsError;
            const finalizing =
              turnFailed ||
              turn == null ||
              strategy.isTerminal(turn) ||
              !strategy.runTurn;
            // A launch failure can terminate before its first model cycle.
            if (turnIndex === 0) {
              if (err != null && !(yield* runSession.ownsRun(runId)))
                return yield* Effect.fail(ensureError(err));
              yield* beginTurn;
            }
            const delivery = yield* settleTurn(
              turn,
              err,
              turnIsError,
              finalizing,
            );

            if (turnFailed) {
              sawTurnFailure = true;
              lastTurnErr =
                err ??
                new Error(
                  `${strategy.stageLabel} reported a failed turn without throwing.`,
                );
              pendingDelivery = delivery;
              break;
            }

            const isTerminal = turn != null && strategy.isTerminal(turn);
            if (isTerminal || !strategy.runTurn) {
              pendingDelivery = delivery;
              break;
            }

            // Process strategies wake the parent before waiting for input.
            yield* submitPendingDelivery(delivery, runSession, runId, trace);
            if (loop.isInterrupted()) break;

            // The park is durable before the block, so a follow-up arriving
            // while this loop sleeps is admitted onto its queue instead of
            // being refused against a run that only looks busy.
            yield* commitPark(runSession, runId, 'parked');
            const nextRunTurn = strategy.runTurn;
            // The queue wait, raced against the loop's stop; null when stopped.
            const batch = yield* Effect.raceFirst(
              input.take,
              onceAborted(loop.signal, () => Effect.succeed(null)),
            ).pipe(Effect.interruptible);
            if (!batch || loop.isInterrupted()) break;
            // The batch leaves the park: the loop is running again from
            // here, and the turn it is about to accept is the top's.
            // A view edit is asked of a root's own loop, never of a child.
            if (batch.kind === 'edit')
              return yield* Effect.die(
                new Error(`${runId}: a child run took a view edit`),
              );
            const taken = batch.kind === 'synthetic' ? [] : batch.followUps;
            yield* commitPark(runSession, runId, 'resumed');
            consumed = taken;
            const prompts: readonly FollowUpContent[] =
              batch.kind === 'synthetic'
                ? [{ text: batch.text, from: { kind: 'user' } }]
                : taken.map((followUp) => followUp.content);
            runner = (signal) => nextRunTurn(prompts, ports, signal);
          }
        }),
      );
      return result;
    }).pipe(
      // The loop's terminal, in the toolUse exit-protocol pattern: a stop
      // lands before it or after it, never inside, so the queue lease, the
      // terminal row, the claim release and the final delivery settle
      // atomically on every exit.
      Effect.onExit((body) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const stopped =
              loop.isInterrupted() ||
              (Exit.isFailure(body) && Cause.hasInterrupts(body.cause));
            if (Exit.isFailure(body) && !Cause.hasInterruptsOnly(body.cause)) {
              const error = Cause.squash(body.cause);
              sawTurnFailure = true;
              lastTurnErr ??= error;
              // A lost aggregate claim: this process no longer owns the run,
              // so the loop stops rather than continue under it.
              if (error instanceof DatabaseNotOwner) loop.interrupt();
            }

            const terminal = yield* Effect.exit(
              Effect.gen(function* () {
                let terminationCause: ChildLoopTerminationCause = 'terminal';
                if (stopped) terminationCause = 'interrupted';
                else if (sawTurnFailure) terminationCause = 'turn_failed';
                // Debug-only driver diagnostic (#9531): how the loop ended.
                yield* loopLog(trace, 'debug', 'childRunLoop loop.terminated', {
                  runId,
                  interruptionCause: terminationCause,
                });
                // Re-read: a stop landing after the body's exit is still the
                // run's terminal verdict.
                const stoppedAtExit = stopped || loop.isInterrupted();
                const outcome = deriveRunOutcome({
                  failed: sawTurnFailure,
                  cancelled: stoppedAtExit,
                });
                if (childRun) {
                  yield* childRun.finalize({
                    outcome,
                    error: lastTurnErr,
                    stopped: stoppedAtExit,
                    stage: sessionStage,
                    // A persist-only child routes nothing to a parent,
                    // so nobody could continue it: its stop cancels it.
                    ...(strategy.deliveryMode !== 'persistOnly' && {
                      pauseNotice: strategy.pauseNotice,
                    }),
                  });
                } else {
                  if (
                    (stoppedAtExit || sawTurnFailure) &&
                    (yield* runSession.ownsRun(runId))
                  ) {
                    // A native run's lifecycle is its one terminal writer,
                    // and its fiber has exited by now (this loop's scope
                    // awaited it). A failure or stop can precede that
                    // lifecycle; one that ran has already ended the run,
                    // which this keeps.
                    yield* endRunOutsideLifecycle(
                      runSession,
                      runId,
                      outcome,
                      lastTurnErr,
                    );
                  }
                  // A user's stop, not a shutdown: what the child left for
                  // its parent to resume, read with the parent's next input.
                  const target = parent.current;
                  if (
                    strategy.stopNotice !== undefined &&
                    strategy.deliveryMode !== 'persistOnly' &&
                    loop.userStopped &&
                    target !== null
                  ) {
                    // A notice that cannot be read still says the child
                    // stopped: the stop stands, and the failure is loud.
                    const text = yield* strategy.stopNotice().pipe(
                      Effect.catch((error) =>
                        loopLog(trace, 'warn', 'Child-run stop notice failed', {
                          runId,
                          error,
                        }).pipe(
                          Effect.as(
                            `Run ${runId} was stopped. What it had done could not be read: ${toErrorMessage(error)}`,
                          ),
                        ),
                      ),
                    );
                    yield* runSession.followUps.send(
                      target,
                      {
                        text,
                        from: { kind: 'run', runId },
                        deliveryId: `${runId}:${attemptId}:stopped`,
                      },
                      { hold: 'instruction' },
                    );
                  }
                }
              }),
            );
            // Provider ids stay reserved until the terminal (or pause) row
            // is written, so a call naming one finds this run, not a gap.
            const owned = yield* Effect.exit(
              Effect.sync(releaseSessionOwnershipOnce),
            );
            const released = yield* Effect.exit(runSession.commitRunEnd(runId));
            if (Exit.isFailure(released)) {
              yield* loopLog(
                trace,
                'warn',
                'Failed to persist final child-run artifacts',
                { runId, error: Cause.squash(released.cause) },
              );
            }
            // The parent may immediately read this child; release its claim first.
            yield* releaseClaim;
            const delivery = yield* Effect.exit(
              submitPendingDelivery(pendingDelivery, runSession, runId, trace),
            );
            const activation = yield* Effect.exit(
              Effect.sync(releaseChildActivation),
            );
            const failures = [
              terminal,
              owned,
              released,
              delivery,
              activation,
            ].flatMap((exit) =>
              Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : [],
            );
            // The body's own failure or interruption propagates past this
            // finalizer as itself; only the cleanup's failures join it.
            if (failures.length > 0) {
              return yield* Effect.fail(
                ensureError(
                  aggregateError(failures, 'Child run and cleanup failed'),
                ),
              );
            }
          }),
        ),
      ),
    );
    // The launched fiber owns settlement from its first step; an unwind of
    // the launch before that still owns the setup it acquired. It is
    // admitted a tick later, once this launch has handed back its fiber.
    return yield* runs.launch(runId, run, (admitted) =>
      Effect.suspend(() => {
        forked = true;
        return Effect.andThen(Effect.yieldNow, admitted).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.gen(function* () {
                  const error = runStarted
                    ? ensureError(Cause.squash(cause))
                    : yield* unwindSetup(Cause.squash(cause));
                  return yield* Effect.fail(error);
                }),
          ),
        );
      }),
    );
  }).pipe(
    Effect.onExit((exit) => {
      if (Exit.isSuccess(exit) || forked || setupUnwound) return Effect.void;
      // The handoff never happened: the setup this launch acquired unwinds
      // here, atomically, rather than leaking the queue lease, the
      // activation and the stage.
      return Effect.uninterruptible(
        Effect.gen(function* () {
          const error = yield* unwindSetup(Cause.squash(exit.cause));
          return yield* Effect.fail(error);
        }),
      );
    }),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.fail(ensureError(Cause.squash(cause))),
    ),
  );
}
