import { randomUUID } from 'node:crypto';
import { Cause, Effect, Exit, type Fiber } from 'effect';

// One driver for every child-run type (agent-CLI codex/claude sessions, native
// subagents of either category, workflow-script runs, background shells). Each
// turn source supplies a ChildRunStrategy; this loop is the single owner of
// everything a driver does NOT vary: follow-up queue
// acquire/drain, one run-handle interrupt target for the child's whole
// lifetime, per-turn delivery choreography (format → persist report → optional
// manifest → deliver with wake), and the terminal call into the shared
// finalizer.
//
// Host-agnostic, VS Code-free.

import { finalizeRun } from '@agent/storage';
import type { AgentTrace, StageHandle } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import type { ChildTurnKey } from '@agent/storage/runRecords';
import {
  assertOwnedRunLease,
  RunLeaseLostError,
} from '@agent/storage/runLease';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { runInSession } from '@agent/runtime/RunContext';
import { finalizeRunTerminal } from '@agent/runtime/AgentRunLifecycle';
import { childRunBudgetFor } from '@agent/runtime/childRunBudget';
import { stepRow } from '@agent/runtime/loop/rows';
import type { RunHandle, RunInterruptHandler } from '@agent/runtime/RunHandle';
import type {
  FollowUpQueue,
  FollowUpQueueBatchItem,
  FollowUpQueueInput,
} from '@agent/followUp/FollowUpQueue';
import type { FollowUpConsumerLease } from '@agent/followUp/ToolUseFollowUpQueueManager';
import {
  enqueueLiveFollowUp,
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import { persistChildRunDelivery } from '@agent/storage/childRunDeliveryPersistence';
import { classifyAgentError } from '@common/errors';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import {
  RUN_OUTCOME,
  aggregateId,
  type ResultMeta,
  type RunId,
  type RunOutcome,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import {
  DatabaseNotOwner,
  type DatabaseWriteFailed,
} from '@shared/session/database';
import { formatSubagentProgress } from '@shared/subagentFollowup';
import { deriveRunOutcome } from '@shared/runs/runStatus';
import { aggregateError, formatDuration, onAbort } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

/** Minimal token usage shape consumed by the loop's turn summary. */
type TurnUsage = { input_tokens?: number; output_tokens?: number };

/**
 * Capabilities the loop provides to a strategy for the duration of one child
 * run. `notify` is best-effort live progress (no report/manifest persist, no
 * gating; duplicate delivery is impossible by construction since there is
 * one delivery site per turn, so there is nothing left to dedupe against).
 *
 * ## Cost accounting contract (the one discipline every child-run type keeps)
 *
 * One fact; "this child's total spend"; flows through three fixed roles:
 *
 * - **Observe.** A strategy reports spend only through `recordCost`, and only
 *   as a *cumulative total for the physical run so far*, never a delta. Native
 *   subagents pass each turn's run-cumulative `usage.totalCost`
 *   (`nativeSubagentStrategy.runNative`). The workflow-script strategy's
 *   attempt model is per-grandchild deltas, so it converts them into an
 *   invocation-cumulative total first (`createWorkflowAttemptCostTracker`) —
 *   the retention rule below is only correct over cumulative observations.
 *   Replayed/recovered journal work observes zero (it was billed by the run
 *   that produced it), and `invocation.report({ costUsd })` is snapshot
 *   display, never accounting.
 * - **Retain.** The loop retains `max(best defined observation)`. Max over
 *   cumulative totals is order-insensitive and monotone, so a later partial
 *   source cannot replace the best available total; max over deltas would
 *   under-bill, which is why observation is cumulative by contract.
 * - **Commit.** Exactly one commit per physical child run, at run end, into
 *   `params.recordCost`; the parent-side callback *adds* into the parent's
 *   usage totals, so a second commit is double-billing and a missed one is
 *   under-billing. The in-band single-cycle path has exactly one observation
 *   per physical attempt and forwards it to its caller's `onCost` once; there
 *   is no multi-observation in-band path, hence no retention layer there.
 * - **Failure path (workflow).** A failed run settles from the checkpoint
 *   journal; if settlement itself fails, that spend stays unbilled and must be
 *   warned about loudly; never silently, and never masking the run error.
 *   Live observations already retained remain committed.
 * - **Agent-CLI children** wire no cost observer by design: their spend is
 *   external (the user's own claude/codex subscription), not TeXRA-billed
 *   USD. A future cost-reporting CLI must observe through this same
 *   cumulative discipline rather than adding a parallel channel.
 */
export interface ChildRunPorts {
  notify(update: SubagentProgressUpdate): void;
  recordCost(totalCost: number | undefined): void;
}

/**
 * Presentation/lifecycle port for agent-CLI child runs. The concrete
 * tool-layer stream satisfies this structurally, but the generic driver
 * declares the handful of hooks it needs here so it never imports a concrete
 * tools type. Native strategies have no stream tab of their own and omit it
 * entirely; `executeAgent`/`resumeToolUseFromResumeData` own handle creation,
 * tracking, and terminal finalization for every turn via `runFlowWithLifecycle`.
 */
interface ChildRunPort {
  readonly logger: AgentTrace;
  /**
   * Complete the child stream lifecycle through the owning run handle.
   * Resolves once the shared terminal finalizer has persisted, settled, and
   * untracked.
   */
  finalize(options: {
    /**
     * The child's report of its own exit. A report, not a verdict: the stream
     * phase owns the terminal outcome, so an explicit stop/kill that already
     * landed CANCELLED outranks a FAILED this reports.
     */
    outcome: RunOutcome;
    /** Cause behind a FAILED outcome, for diagnosis. */
    error?: unknown;
    /** Session stage closed with the derived outcome (the loop's stage). */
    stage?: Pick<StageHandle, 'end'>;
    /** Drop the child's tab once finalized (ephemeral process children). */
    autoClose?: boolean;
  }): Effect.Effect<void, Error>;
}

/**
 * Provider-specific behavior for a single child run. Created once per run;
 * its methods close over the provider's thread/session object, registry, and
 * runtime host.
 *
 * `launch` produces the first turn's outcome (agent-CLI: delegates to
 * `runTurn` with the seeded initial prompt; native: the `executeAgent`
 * call itself). `runTurn` produces every following turn's outcome, given the
 * follow-up items the loop drained since the previous turn (agent-CLI joins
 * their text into one prompt; native injects the already-consumed batch at
 * the resumed flow's persisted WAITING boundary without re-enqueueing it).
 *
 * Per-turn call order: `launch`/`runTurn` → `getUsage` (turn summary) →
 * `isTurnError` → `onTurnError` (if true) → `publishUsage` →
 * `formatDelivery`/`formatError` → `buildResultMeta` → `onTurnSuccess` (only
 * while the loop remains active) → route/wake the parent.
 * Failed turns release session ownership before routing/waking the parent;
 * interrupted turns release ownership but skip parent delivery entirely.
 */
export interface ChildRunStrategy<TTurn, R = never> {
  /** Stage label opened on the child trace (e.g. "Codex session"). */
  readonly stageLabel: string;

  /**
   * This child's turns drive a live OS process, so the loop's interrupt
   * handler tears one down. Shutdown drain reads it off the handle to reach a
   * leaked process (`RunRegistry.killBackgroundProcesses`) without
   * disturbing agent children that are deliberately left running for restart
   * recovery; see `RunInterruptHandler.ownsBackgroundProcess`.
   */
  readonly ownsBackgroundProcess?: boolean;

  /**
   * Drop the child's run tab when the run finalizes. For a child whose tab
   * is ephemeral by construction (a background shell), the tab exists only
   * while the process does; every other child type keeps its tab for reading
   * back.
   */
  readonly autoCloseChildRun?: boolean;

  /**
   * Deliver a settled turn to the parent even when the loop was interrupted.
   * Default (and right for every agent child) is not to: an interrupted turn
   * has no result to report. A killed OS process is the exception; it still
   * reports a complete result (exit code plus the output it produced), and a
   * parent suspended on that job would otherwise never be told it ended.
   */
  readonly deliverAfterInterrupt?: boolean;

  /**
   * `persistOnly` records the terminal report without routing it to a parent.
   * Used when a headless caller awaits and reads that report itself. Omitted
   * strategies deliver normally.
   */
  readonly deliveryMode?: 'persistOnly';

  /**
   * Produce the first turn's outcome. Throws on hard failure. `R` names the
   * process services a turn reads (the native strategy's engine turns read
   * `ToolInjections` and `AppState`); the loop forwards it to its caller,
   * where the process runtime provides them.
   */
  launch(
    ports: ChildRunPorts,
    signal: AbortSignal,
  ): Effect.Effect<TTurn, Error, R>;

  /**
   * Produce the next turn's outcome from the queued follow-up batch. Throws
   * on hard failure. Omitted by strategies whose first (and only) turn is
   * always terminal (workflow-script); the loop never calls `runTurn` in
   * that case, since it only continues past a non-terminal turn. The native
   * subagent strategy declares `runTurn` unconditionally, even for a
   * workflow-category child; it is simply unreachable there, since
   * `isTerminal` is always true on that child's first turn.
   */
  runTurn?(
    followUps: readonly FollowUpQueueBatchItem[],
    ports: ChildRunPorts,
    signal: AbortSignal,
  ): Effect.Effect<TTurn, Error, R>;

  /** True when `turn` ends this child's run; no further turns follow. */
  isTerminal(turn: TTurn): boolean;

  /** Token usage for the turn summary (null when none). */
  getUsage?(turn: TTurn): TurnUsage | null;

  /**
   * Application-level error reported by a turn that did NOT throw (e.g. the SDK
   * returned an error result). Omit for providers that always throw on failure.
   */
  isTurnError?(turn: TTurn): boolean;

  /** Log a turn-level error message for a non-throwing failure. */
  onTurnError?(turn: TTurn, logger: AgentTrace): void;

  /** After loop setup, before the initial turn starts. */
  onLoopStart?(session: SessionHandle): void;

  /** After a successful turn: register the session/thread id, etc. */
  onTurnSuccess?(turn: TTurn, session: SessionHandle): void;

  /** Publish token usage to the UI. */
  publishUsage?(turn: TTurn): void;

  /**
   * Format the success delivery XML. A native workflow-category subagent
   * computes this asynchronously (diff files are written to the run
   * directory first).
   */
  formatDelivery(turn: TTurn, wallTimeMs: number): string | Promise<string>;

  /** Format the error delivery XML (turn is null when the call threw). */
  formatError(turn: TTurn | null, err: unknown): string | Promise<string>;

  /**
   * Structured result manifest for a turn's delivery, persisted alongside the
   * report so `/executions/{id}/result` reflects the latest turn; called for
   * both success and failure (`turn` is null when the call threw, `isError`
   * is set for both a throw and a non-throwing application-level failure) so
   * a failure overwrites any earlier interim-success manifest instead of
   * leaving it stale. Native strategies provide one per turn; agent-CLI
   * strategies omit it; they have no chaining-manifest contract.
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
  ): Effect.Effect<ResultMeta | undefined, Error>;

  /**
   * Where a turn's delivery should be sent. Native strategies track their
   * per-turn handle directly. Child-stream loops omit this and the driver reads
   * their persistent handle's live `deliveryTarget`, which goes `undefined`
   * once the child is detached from its orchestrator.
   */
  resolveDeliveryTarget?(): RunId | undefined;

  /**
   * Release provider-owned registry entries. The loop calls this exactly once,
   * before failed/interrupted parent delivery or during finalization.
   */
  releaseSessionOwnership?(): void;
}

export interface ChildRunLoopParams<TTurn, R = never> {
  readonly session: SessionHandle;
  /**
   * Presentation/lifecycle wrapper for agent-CLI child runs. Native
   * strategies omit this; `executeAgent`/`resumeToolUseFromResumeData`
   * already own handle creation, tracking, and terminal finalization for
   * every turn via `runFlowWithLifecycle`, so there is no separate run tab
   * for this loop to finalize.
   */
  readonly childRun?: ChildRunPort;
  readonly parentRunId: RunId;
  /** The child's run id: what the loop acquires the follow-up queue and
   *  attaches its interrupt handler under, before the first turn runs. */
  readonly runId: RunId;
  readonly agentName: string;
  readonly strategy: ChildRunStrategy<TTurn, R>;
  /**
   * Roll this child's final cost into the parent's usage totals. Omitted by
   * agent-CLI callers (no cost concept today); native delegation passes its
   * captured `recordSubagentCost` closure.
   */
  readonly recordCost?: (totalCost: number | undefined) => void | Promise<void>;
  /**
   * Gate every turn through the session's shared child-run budget
   * (`childRunBudgetFor`). Set by the detached native/workflow launch path;
   * agent-CLI callers omit it; their children are external processes on the
   * user's own subscription, outside both the cost contract and the budget
   * (see `.agents/docs/implemented/architecture/2026-08-15-child-run-concurrency-budget.md`).
   */
  readonly budgeted?: boolean;
  /**
   * Progress sink override for awaiting callers of a persist-only child: the
   * parent is blocked inside a tool call, so follow-up delivery cannot reach
   * it and the caller degrades deliberately (e.g. to the parent run's trace).
   * When present it replaces follow-up delivery for every progress update.
   */
  readonly notify?: (update: SubagentProgressUpdate) => void;
  /**
   * Hands an awaiting caller each settled turn's facts in memory; the
   * formatted message, the (turn-stamped) result manifest, and the raw error
   * of a failed turn. Persistence stays best-effort in the loop; a caller
   * with a required-durability contract verifies the store afterwards rather
   * than changing what the loop persists. Fires after persistence, once per
   * settled turn.
   */
  readonly onTurnSettled?: (settled: {
    readonly message: string;
    readonly resultMeta?: ResultMeta;
    readonly isError: boolean;
    readonly error?: unknown;
  }) => void;
  /** Publish caller-owned state after final artifacts drain, before lease release. */
  readonly afterArtifactsDrained?: Effect.Effect<void, Error>;
}

/**
 * Interrupt handler attached to the child's run handle for the child's
 * whole lifetime, so the stop button always finds a live target; including
 * the inter-turn WAITING gap, when no flow-owned context is attached.
 *
 * Carries no flow-owned session view, so flow-only commands such as context
 * compaction ignore it. Follow-ups route through the queue-owned submission
 * path, which joins this loop's live lease instead of creating a competing
 * continuation.
 *
 * A running turn is reached through `signal` alone: every strategy binds the
 * turn it launches to it, and a native turn's flow subscribes to its own run
 * signal downstream of that binding.
 */
class ChildRunInterruptible implements RunInterruptHandler {
  private readonly controller = new AbortController();
  private queue: FollowUpQueue | null = null;

  constructor(
    /**
     * Only a strategy that declares `ownsBackgroundProcess` sets this: a
     * loop-level handler for an agent child must stay invisible to shutdown
     * drain so restart recovery still finds it (#8155).
     */
    readonly ownsBackgroundProcess: boolean,
  ) {}

  interrupt(): void {
    this.controller.abort();
    this.queue?.cancelWait();
  }

  setQueue(q: FollowUpQueue): void {
    this.queue = q;
  }

  isInterrupted(): boolean {
    return this.controller.signal.aborted;
  }

  /**
   * The one cancellation signal every turn of this child runs under. No turn
   * starts after an interrupt (the loop checks `isInterrupted()` first), so a
   * per-turn controller would only ever mirror this one.
   */
  get signal(): AbortSignal {
    return this.controller.signal;
  }
}

/** Log a turn summary (duration + token usage) to the child stream. */
function logTurnSummary(
  logger: AgentTrace,
  wallTimeMs: number,
  usage: TurnUsage | null | undefined,
): void {
  logger.info(`Turn completed in ${formatDuration(wallTimeMs)}`);
  if (usage) {
    logger.info('Tokens', {
      data: {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
      },
    });
  }
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
 */
function attemptTurn<TTurn, R>(
  strategy: ChildRunStrategy<TTurn, R>,
  runner: (signal: AbortSignal) => Effect.Effect<TTurn, Error, R>,
  loop: ChildRunInterruptible,
  logger: AgentTrace,
  startedAt: number,
): Effect.Effect<TurnAttempt<TTurn>, never, R> {
  return Effect.gen(function* () {
    const attempt = yield* Effect.exit(
      Effect.gen(function* () {
        const turn = yield* runner(loop.signal);
        logTurnSummary(
          logger,
          Date.now() - startedAt,
          strategy.getUsage?.(turn),
        );
        const turnIsError = strategy.isTurnError?.(turn) === true;
        if (turnIsError) strategy.onTurnError?.(turn, logger);
        return { kind: 'completed' as const, turn, turnIsError };
      }),
    );
    if (Exit.isSuccess(attempt)) return attempt.value;
    const caught = Cause.squash(attempt.cause);
    if (loop.isInterrupted() || isUserAbort(caught)) {
      return { kind: 'interrupted' as const };
    }
    logger.error(toErrorMessage(caught));
    return { kind: 'failed' as const, err: caught };
  });
}

/**
 * The delivery id one accepted turn's single parent delivery is admitted
 * under (#9531): derived from the turn's structural identity, the
 * `child.turn` row's key (run, attempt, turn index), never persisted beside
 * it, so the two can never disagree. Stable within one child-run attempt and
 * distinct across attempts, even when a workflow deliberately reuses its run
 * id, so a producer replaying the same accepted turn presents the same id
 * while a later workflow run cannot collide with its prior delivery.
 */
function turnDeliveryId(runId: RunId, turn: ChildTurnKey): string {
  return `${runId}:${turn.attemptId}:${turn.turnIndex}:delivery`;
}

/**
 * Why the child-run loop stopped, for the structured termination diagnostic.
 */
type ChildLoopTerminationCause = 'interrupted' | 'turn_failed' | 'terminal';

/**
 * Structured turn-lifecycle diagnostic (#9531): ties the run, the turn's
 * logical identity, the follow-up queue owner/generation, and the interruption
 * cause into one event so a resumed/interrupted child's state is auditable.
 * Emitted at turn acceptance, delivery, and loop termination.
 *
 * Debug level: this is the loop's own bookkeeping, not the child's narrative.
 * A child stream tab renders what its provider produced; for a background
 * shell that tab IS the terminal, and `/executions/{id}/output` states that it
 * projects command output rather than run bookkeeping. Debug mode keeps the
 * audit trail for the case that motivated it.
 */
function emitTurnDiagnostic(
  logger: AgentTrace,
  event: 'turn.accepted' | 'turn.delivered' | 'loop.terminated',
  params: {
    runId: RunId;
    turn?: ChildTurnKey;
    queueOwner?: FollowUpConsumerLease;
    interruptionCause?: ChildLoopTerminationCause;
  },
): void {
  const { runId, turn, queueOwner, interruptionCause } = params;
  logger.debug(`childRunLoop ${event}`, {
    data: {
      runId,
      ...(turn ? { attemptId: turn.attemptId, turnIndex: turn.turnIndex } : {}),
      ...(queueOwner ? { queueOwner: queueOwner.kind } : {}),
      ...(interruptionCause ? { interruptionCause } : {}),
    },
  });
}

/**
 * Commit one turn's `child.turn` row (#9531), the fact the report/result
 * slots are attributed from. Not best-effort: a refused append is the turn's
 * failure. `not-owner` means this process no longer holds the run and the
 * loop stops rather than deliver under a claim it lost (R7); a write failure
 * is a fact the slots cannot be labeled without.
 */
function commitChildTurn(
  session: SessionHandle,
  runId: RunId,
  turn: ChildTurnKey,
  phase: 'accepted' | 'settled',
): Effect.Effect<void, DatabaseNotOwner | DatabaseWriteFailed> {
  return session
    .commit([
      {
        type: 'child.turn',
        aggregateId: aggregateId('run', runId),
        attemptId: turn.attemptId,
        turnIndex: turn.turnIndex,
        phase,
      },
    ])
    .pipe(Effect.asVoid);
}

/**
 * Move an agent-CLI child's phase across its park (one run model, 3.3):
 * `waiting` before the loop blocks on its queue, `turn.begin` when the drained
 * batch starts the next turn. Written with the loops' own step-row
 * constructor, so the child protocol carries no second phase vocabulary. A run
 * this loop is the only driver of has no `flow.snapshot` and no rounds: its
 * family is the interactive one its turns are, and the turn index is its one
 * moving coordinate. Without the park row the run stays RUNNING while idle and
 * `getToolUseFollowUpTarget` classifies the next turn's submission as
 * `no_session`; native children park through their own loop's `waiting` row
 * and are never written here, so each park keeps one writer.
 */
function commitFlowStep(
  session: SessionHandle,
  runId: RunId,
  turn: number,
  step: 'waiting' | 'turn.begin',
): Effect.Effect<void, DatabaseNotOwner | DatabaseWriteFailed> {
  return session
    .commit([
      stepRow(
        runId,
        { family: 'toolUse', round: 0, turn, continuationIndex: 0 },
        step,
      ),
    ])
    .pipe(Effect.asVoid);
}

/**
 * Where this turn's output goes. Native strategies resolve their per-turn
 * handle; child-stream loops receive their persistent handle's live target.
 * Either may return `undefined` after detachment, which must skip delivery
 * entirely rather than silently falling back to the old parent.
 */
function resolveDeliveryTarget<TTurn, R>(
  strategy: ChildRunStrategy<TTurn, R>,
  resolveChildRunTarget: () => RunId | undefined,
): RunId | undefined {
  return strategy.resolveDeliveryTarget
    ? strategy.resolveDeliveryTarget()
    : resolveChildRunTarget();
}

/**
 * A turn's parent-follow-up enqueue, still pending its wake step. Waking can
 * await the resumed parent's entire turn (`agentResume.tryResumeRun` → …
 * → `resumeToolUseFromResumeData`), so callers that are about to finalize this
 * child (terminal/failed turns) must resolve the wake only AFTER that
 * finalize completes; otherwise a resumed parent that immediately waits on
 * this still-RUNNING run self-stalls (#8093). Callers that continue to
 * another turn (no finalize pending) may wake immediately.
 */
interface PendingChildDelivery {
  readonly resolveTargetRunId: () => RunId | undefined;
  readonly followUp: FollowUpQueueInput;
}

/**
 * A turn result with nowhere to go: the child detached from its orchestrator,
 * so the report slot is the only place the outcome survives. Shared by the
 * enqueue site and the deferred wake site, which resolve the target at
 * different times.
 */
function warnDetachedChildDelivery(logger: AgentTrace, runId: RunId): void {
  logger.warn(
    'Turn result not delivered: child was detached from its orchestrator. The result remains in the run report.',
    { data: { runId } },
  );
}

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
  logger: AgentTrace;
  turn: TTurn | null;
  turnKey: ChildTurnKey;
  err: unknown;
  wallTimeMs: number;
  isError: boolean;
  prepareParentDelivery?: () => boolean;
  resolveDefaultDeliveryTarget: () => RunId | undefined;
  onTurnSettled?: ChildRunLoopParams<TTurn>['onTurnSettled'];
}): Effect.fn.Return<PendingChildDelivery | undefined, Error> {
  const {
    strategy,
    runId,
    logger,
    turn,
    turnKey,
    err,
    wallTimeMs,
    isError,
    prepareParentDelivery,
    resolveDefaultDeliveryTarget,
  } = params;
  const delivered = turn != null && !isError;
  const msg = yield* Effect.tryPromise({
    try: async () =>
      runInSession(params.session, () =>
        delivered
          ? strategy.formatDelivery(turn, wallTimeMs)
          : strategy.formatError(turn, err),
      ),
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
  // The turn settled whatever the delivery persistence did: its settle path
  // ran, which is the fact a recovering caller's re-execution gate reads (a
  // settled `child.turn` under a run with no outcome and no result manifest
  // refuses repetition), so
  // the row lands before that failure is raised.
  yield* commitChildTurn(params.session, runId, turnKey, 'settled');

  params.onTurnSettled?.({
    message: msg,
    ...(resultMeta !== undefined && { resultMeta }),
    isError,
    ...(err != null && { error: err }),
  });
  if (Exit.isFailure(persisted))
    return yield* Effect.failCause(persisted.cause);

  if (strategy.deliveryMode === 'persistOnly') return undefined;

  const resolveTargetRunId = (): RunId | undefined =>
    resolveDeliveryTarget(strategy, resolveDefaultDeliveryTarget);
  if (!resolveTargetRunId()) {
    warnDetachedChildDelivery(logger, runId);
    return undefined;
  }
  if (prepareParentDelivery?.() === false) return undefined;
  return {
    resolveTargetRunId,
    followUp: {
      text: msg,
      origin: 'subagent_result',
      deliveryId: turnDeliveryId(runId, turnKey),
    },
  };
});

/**
 * Resolve a pending delivery's wake step (no-op when there is nothing to
 * wake, or the enqueue itself found no session; already logged above).
 */
const submitPendingDelivery = Effect.fn('submitPendingDelivery')(function* (
  pending: PendingChildDelivery | undefined,
  session: SessionHandle,
  runId: RunId,
  logger: AgentTrace,
): Effect.fn.Return<void, Error> {
  if (!pending) return;
  const targetRunId = pending.resolveTargetRunId();
  if (!targetRunId) {
    warnDetachedChildDelivery(logger, runId);
    return;
  }
  const delivery = yield* submitFollowUp(targetRunId, pending.followUp, {
    session,
  });
  if (delivery.status === 'failed') {
    logger.warn(
      `Turn result not delivered: parent run is unavailable (${delivery.reason}). The result remains in the run report.`,
      {
        data: {
          runId,
          parentRunId: targetRunId,
          reason: delivery.reason,
        },
      },
    );
  } else if (delivery.status === 'queued' && delivery.wake === 'failed') {
    logger.warn(
      'Turn result queued for the parent, but the parent could not be resumed; an explicit Resume delivers it.',
      { data: { runId, parentRunId: targetRunId } },
    );
  }
});

/**
 * Own admitted run cleanup until the child loop takes over. Failure or
 * interruption records the terminal outcome and releases canonical and file
 * claims before propagating the original cause. Post-handoff work stays outside
 * this owner because the live child then owns its own settlement.
 */
export function runWithOwnedRunLeaseLaunchGuard<A, E, R>(
  session: SessionHandle,
  runId: RunId,
  operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Error, R> {
  return operation.pipe(
    Effect.onExit((exit) => {
      if (Exit.isSuccess(exit)) return Effect.void;
      return Effect.gen(function* () {
        const finalized = yield* Effect.exit(
          finalizeRun(session, {
            runId,
            outcome: Cause.hasInterrupts(exit.cause)
              ? RUN_OUTCOME.CANCELLED
              : RUN_OUTCOME.FAILED,
          }),
        );
        const released = yield* Effect.exit(session.releaseRunLease(runId));
        const failures: unknown[] = [];
        if (Exit.isFailure(finalized))
          failures.push(Cause.squash(finalized.cause));
        else if (!finalized.value.ok) failures.push(finalized.value.error);
        if (Exit.isFailure(released))
          failures.push(Cause.squash(released.cause));
        if (failures.length > 0)
          return yield* Effect.fail(
            new AggregateError(failures, `Run ${runId} launch cleanup failed`),
          );
      });
    }),
  );
}

/**
 * Drive a child run: the initial turn goes through `strategy.launch`, then
 * every following turn is drained from the child's follow-up queue and run
 * through `strategy.runTurn`. Each turn's result (or error) is delivered to
 * the parent's follow-up queue and persisted as a report; the run ends when a
 * turn is terminal, a turn fails, or the loop is interrupted.
 * Setup completes before the returned fiber takes responsibility for the run.
 * The launcher handles setup failures; the fiber owns terminal cleanup.
 */
export function startChildRunLoop<TTurn, R = never>(
  params: ChildRunLoopParams<TTurn, R>,
): Effect.Effect<Fiber.Fiber<void, Error>, Error, R> {
  return Effect.gen(function* () {
    const runSession = params.session;
    const budget = params.budgeted
      ? yield* childRunBudgetFor(runSession)
      : undefined;
    const { childRun, parentRunId, runId, agentName, strategy } = params;
    // Agent-CLI children log to their own presentation stream; native children
    // have no stream tab of their own here (each turn already logs through its
    // own run trace inside `runFlowWithLifecycle`), so this is a channel-only
    // fallback for the loop's own turn-summary/warning lines.
    const logger = childRun?.logger ?? createChannelTrace('childRunLoop');
    // The code below is synchronous until the loop task is spawned, so a run
    // that does not own its lease fails before any queue, stage, or loop exists.
    runInSession(runSession, () => assertOwnedRunLease(runId));
    const loop = new ChildRunInterruptible(
      strategy.ownsBackgroundProcess === true,
    );
    // Native children have no persistent child-stream handle between turns, so
    // retain their parent lineage until final delivery. Child-stream loops own
    // their lifecycle through that stream instead; reserving parent delivery for
    // them would make a terminal parent look recoverable after it can no longer
    // accept either user input or the child's result.
    let activationDetached = false;
    const releaseChildActivation = childRun
      ? () => undefined
      : runSession.runs.reserveChildActivation({
          runId,
          parentRunId,
          interrupt: () => loop.interrupt(),
          detach: () => {
            activationDetached = true;
          },
          isDetached: () => activationDetached,
        });
    let sessionOwnershipReleased = false;
    const releaseSessionOwnershipOnce = (): void => {
      if (sessionOwnershipReleased) return;
      sessionOwnershipReleased = true;
      strategy.releaseSessionOwnership?.();
    };

    let queue!: FollowUpQueue;
    let queueLease: FollowUpConsumerLease | undefined;
    let attachedHandle: RunHandle | undefined;
    let detachLoopInterrupt: (() => void) | undefined;
    const attachLoopInterrupt = (): void => {
      const handle = runSession.runs.getHandle(runId);
      if (!handle || handle === attachedHandle) return;
      detachLoopInterrupt?.();
      attachedHandle = handle;
      detachLoopInterrupt = handle.attachInterruptHandler(loop);
    };
    let sessionStage: StageHandle | undefined;
    // Preserve the setup error while unwinding every resource acquired so far.
    // Used when setup throws and when the lane refuses the run before it
    // starts; in both cases `run` never executes, so nothing else unwinds.
    const unwindSetup = (error: unknown): Effect.Effect<Error> =>
      Effect.gen(function* () {
        const cleanupErrors: unknown[] = [];
        const cleanups = [
          () => sessionStage?.end(RUN_OUTCOME.FAILED),
          () => detachLoopInterrupt?.(),
          () => {
            if (queueLease)
              runSession.followUps.release(queueLease, 'terminal');
          },
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

    const setup = yield* Effect.exit(
      Effect.sync(() => {
        strategy.onLoopStart?.(runSession);
        // Revalidate at the state transition itself: setup hooks above may run
        // arbitrary synchronous code after the early fail-fast lease check.
        runInSession(runSession, () => assertOwnedRunLease(runId));
        queueLease = runSession.followUps.claimChildRun(runId);
        if (!queueLease) {
          throw new Error(
            `Follow-up continuation already has an owner for child ${runId}.`,
          );
        }
        queue = runSession.followUps.queue(queueLease);
        loop.setQueue(queue);
        attachLoopInterrupt();
        sessionStage = childRun
          ? logger.openStage(strategy.stageLabel)
          : undefined;
      }),
    );
    if (Exit.isFailure(setup)) {
      return yield* Effect.fail(yield* unwindSetup(Cause.squash(setup.cause)));
    }

    const attemptId = randomUUID();
    // Keep the child-stream handle itself, not a target snapshot. Finalization
    // untracks the handle before terminal delivery, while detachment still
    // mutates this object's live delivery target.
    const childRunHandle = childRun
      ? runSession.runs.getHandle(runId)
      : undefined;

    let bestCostUsd: number | undefined;
    const ports: ChildRunPorts = {
      notify: (update) => {
        if (params.notify) {
          params.notify(update);
          return;
        }
        if (strategy.deliveryMode === 'persistOnly' || activationDetached)
          return;
        const targetRunId = resolveDeliveryTarget(strategy, () =>
          childRun ? childRunHandle?.deliveryTarget : parentRunId,
        );
        if (!targetRunId) return;
        const msg = formatSubagentProgress(runId, agentName, update);
        enqueueLiveFollowUp(
          targetRunId,
          { text: msg, origin: 'subagent_result' },
          runSession,
        );
      },
      recordCost: (totalCost) => {
        if (totalCost !== undefined) {
          bestCostUsd = Math.max(bestCostUsd ?? 0, totalCost);
        }
      },
    };

    let sawTurnFailure = false;
    let lastTurnErr: unknown;
    // A delivery whose wake is still pending. Set right before any `break` out
    // of the loop below (terminal/failed turn) and resolved AFTER this child's
    // own finalize in the `finally` block; never before; so a resumed parent
    // that immediately waits on this run always finds it terminal
    // (#8093). Interim (non-terminal) turns wake inline, immediately, since no
    // finalize is pending for them.
    let pendingDelivery: PendingChildDelivery | undefined;
    // One slot per live turn: acquired here; the single boundary that drives
    // every detached native child turn; and nowhere above or below (design:
    // .agents/docs/implemented/architecture/2026-08-15-child-run-concurrency-budget.md).
    const gateTurn = (
      base: (signal: AbortSignal) => Effect.Effect<TTurn, Error, R>,
    ): ((signal: AbortSignal) => Effect.Effect<TTurn, Error, R>) =>
      budget === undefined
        ? base
        : (signal) =>
            Effect.raceFirst(
              budget.withPermit(Effect.uninterruptible(base(signal))),
              Effect.callback<never, Error>((resume) => {
                const detach = onAbort(signal, () =>
                  resume(
                    Effect.fail(
                      new Error(
                        'Child run turn cancelled while awaiting a concurrency slot.',
                      ),
                    ),
                  ),
                );
                return Effect.sync(detach);
              }),
            ).pipe(Effect.interruptible);

    let runStarted = false;
    const run = Effect.gen(function* () {
      runStarted = true;
      let runner: (signal: AbortSignal) => Effect.Effect<TTurn, Error, R> = (
        signal,
      ) => strategy.launch(ports, signal);
      let turnIndex = 0;
      const body = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            while (!loop.isInterrupted()) {
              turnIndex += 1;
              const turnKey: ChildTurnKey = { attemptId, turnIndex };
              emitTurnDiagnostic(logger, 'turn.accepted', {
                runId,
                turn: turnKey,
                queueOwner: queueLease,
              });
              // Acceptance is committed before dispatch: the row is what
              // attributes the slots while the turn runs.
              yield* commitChildTurn(runSession, runId, turnKey, 'accepted');
              const startedAt = Date.now();
              const attempt = yield* attemptTurn(
                strategy,
                gateTurn(runner),
                loop,
                logger,
                startedAt,
              );
              attachLoopInterrupt();
              if (attempt.kind === 'interrupted') break;

              const turn = attempt.kind === 'completed' ? attempt.turn : null;
              const err = attempt.kind === 'failed' ? attempt.err : null;
              const turnIsError =
                attempt.kind === 'completed' ? attempt.turnIsError : false;
              const wallTimeMs = Date.now() - startedAt;
              const turnFailed = err != null || turnIsError;

              if (turn != null) {
                strategy.publishUsage?.(turn);
              }

              const delivery = yield* deliverTurn({
                session: runSession,
                strategy,
                runId,
                resolveDefaultDeliveryTarget: () =>
                  childRun ? childRunHandle?.deliveryTarget : parentRunId,
                logger,
                turn,
                turnKey,
                err,
                wallTimeMs,
                isError: turnFailed,
                onTurnSettled: params.onTurnSettled,
                prepareParentDelivery: () => {
                  if (activationDetached) return false;
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
              emitTurnDiagnostic(logger, 'turn.delivered', {
                runId,
                turn: turnKey,
                queueOwner: queueLease,
              });

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
                // A strategy without `runTurn` (workflow-script) declares every
                // turn terminal via `isTerminal`; reaching here with one still
                // undeclared-terminal is a strategy bug, not a run outcome; stop
                // rather than call an absent `runTurn`.
                pendingDelivery = delivery;
                break;
              }

              // Interim turn continuing: no finalize is pending, so wake now; the
              // loop's interrupt handler is already attached (immediately above,
              // the instant this turn settled); then just drain the next batch. A
              // follow-up already raced into the queue resumes immediately instead
              // of genuinely waiting.
              yield* submitPendingDelivery(delivery, runSession, runId, logger);
              if (loop.isInterrupted()) break;

              // The park is durable before the block, so a follow-up arriving
              // while this loop sleeps is admitted onto its queue instead of
              // being refused against a run that only looks busy.
              if (childRun)
                yield* commitFlowStep(runSession, runId, turnIndex, 'waiting');
              const batch = yield* Effect.tryPromise({
                try: () => queue.waitAndDrainAll(loop.signal),
                catch: ensureError,
              });
              if (!batch || loop.isInterrupted()) break;
              // The batch leaves the park: the next turn's index is the one
              // the top of the loop is about to accept.
              if (childRun)
                yield* commitFlowStep(
                  runSession,
                  runId,
                  turnIndex + 1,
                  'turn.begin',
                );

              const nextRunTurn = strategy.runTurn;
              runner = (signal) => nextRunTurn(batch.items, ports, signal);
            }
          }),
        ),
      );
      if (Exit.isFailure(body)) {
        const error = Cause.squash(body.cause);
        sawTurnFailure = true;
        lastTurnErr ??= error;
        // A lost file lease or a lost aggregate claim: this process no longer
        // owns the run, so the loop stops rather than continue under it.
        if (
          error instanceof RunLeaseLostError ||
          error instanceof DatabaseNotOwner
        )
          loop.interrupt();
      }

      const terminal = yield* Effect.exit(
        Effect.gen(function* () {
          detachLoopInterrupt?.();
          let terminationCause: ChildLoopTerminationCause = 'terminal';
          if (loop.isInterrupted()) terminationCause = 'interrupted';
          else if (sawTurnFailure) terminationCause = 'turn_failed';
          emitTurnDiagnostic(logger, 'loop.terminated', {
            runId,
            queueOwner: queueLease,
            interruptionCause: terminationCause,
          });
          if (queueLease) runSession.followUps.release(queueLease, 'terminal');
          releaseSessionOwnershipOnce();
          yield* Effect.forkDetach(
            Effect.tryPromise({
              try: async () => params.recordCost?.(bestCostUsd),
              catch: ensureError,
            }).pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  logger.warn('Child cost observer failed', { data: error });
                }),
              ),
            ),
            { startImmediately: true },
          );

          const outcome = deriveRunOutcome({
            failed: sawTurnFailure,
            cancelled: loop.isInterrupted(),
          });
          if (childRun) {
            yield* childRun.finalize({
              outcome,
              error: lastTurnErr,
              stage: sessionStage,
              ...(strategy.autoCloseChildRun === true && {
                autoClose: true,
              }),
            });
          } else {
            // A native turn normally finalizes itself. A stopped between-turn handle remains ours.
            const handle = runSession.runs.getHandle(runId);
            if (handle) {
              yield* finalizeRunTerminal({
                session: runSession,
                handle,
                outcome,
                error:
                  sawTurnFailure && lastTurnErr !== undefined
                    ? {
                        kind: classifyAgentError(lastTurnErr),
                        message: toErrorMessage(lastTurnErr),
                      }
                    : undefined,
              });
            }
          }
          // Parent wake follows the child's terminal commit and handle settlement.
          yield* submitPendingDelivery(
            pendingDelivery,
            runSession,
            runId,
            logger,
          );
        }),
      );
      const released = yield* Effect.exit(
        runSession.releaseRunLease(
          runId,
          !sawTurnFailure ? params.afterArtifactsDrained : Effect.void,
        ),
      );
      if (Exit.isFailure(released)) {
        logger.warn('Failed to persist final child-run artifacts', {
          data: { runId, error: Cause.squash(released.cause) },
        });
      }
      const activation = yield* Effect.exit(
        Effect.sync(releaseChildActivation),
      );
      const failures = [body, terminal, released, activation].flatMap((exit) =>
        Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : [],
      );
      if (failures.length > 0) {
        return yield* Effect.fail(
          ensureError(aggregateError(failures, 'Child run and cleanup failed')),
        );
      }
    }).pipe(Effect.uninterruptible);
    return yield* Effect.forkDetach(
      runSession.runs.launchRun(runId, run).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const error = runStarted
              ? ensureError(Cause.squash(cause))
              : yield* unwindSetup(Cause.squash(cause));
            return yield* Effect.fail(error);
          }),
        ),
      ),
    );
  }).pipe(
    Effect.catchCause((cause) => Effect.fail(ensureError(Cause.squash(cause)))),
    Effect.uninterruptible,
  );
}
