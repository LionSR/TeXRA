// One driver for every child-run type (agent-CLI codex/claude sessions, native
// subagents of either category, workflow-script runs). Each turn source
// supplies an AgentCliSessionStrategy-shaped ChildRunStrategy; this loop is the
// single owner of everything a driver does NOT vary: follow-up queue
// acquire/drain, one run-handle interrupt target for the child's whole
// lifetime, per-turn delivery choreography (format → persist report → optional
// manifest → deliver with wake), and the terminal call into the shared
// finalizer.
//
// Host-agnostic, VS Code-free.

import PQueue from 'p-queue';

import {
  getExecutionStore,
  type ChildTurnRef,
  type ChildTurnState,
  type ResultMeta,
} from '@agent/storage';
import type { AgentTrace, StageHandle } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import {
  onOwnedExecutionLeaseLost,
  captureOwnedExecutionLease,
} from '@agent/storage/executionLease';
import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import {
  finalizeRunTerminal,
  type RunTerminalPersistence,
} from '@agent/runtime/AgentRunLifecycle';
import { childRunBudgetFor } from '@agent/runtime/childRunBudget';
import type {
  AgentExecutionHandle,
  ExecutionInterruptHandler,
} from '@agent/runtime/ExecutionHandle';
import type {
  FollowUpQueue,
  FollowUpQueueBatchItem,
  FollowUpQueueInput,
} from '@agent/followUp/FollowUpQueue';
import type { FollowUpConsumerLease } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { deliverChildRunFollowUp } from '@agent/followUp/childRunDelivery';
import { persistChildRunDeliveryBestEffort } from '@agent/storage/childRunDeliveryPersistence';
import { classifyAgentError } from '@common/errors';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import {
  RUN_OUTCOME,
  type ExecutionId,
  type StreamTabId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import { formatSubagentProgress } from '@shared/subagentFollowup';
import { deriveRunOutcome } from '@shared/streams/streamStatus';
import { aggregateError, formatDuration } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

/** Minimal token usage shape consumed by the loop's turn summary. */
type TurnUsage = { input_tokens?: number; output_tokens?: number };

/**
 * Capabilities the loop provides to a strategy for the duration of one child
 * run. `notify` is best-effort live progress (no report/manifest persist, no
 * gating — duplicate delivery is impossible by construction since there is
 * one delivery site per turn, so there is nothing left to dedupe against).
 *
 * ## Cost accounting contract (the one discipline every child-run type keeps)
 *
 * One fact — "this child's total spend" — flows through three fixed roles:
 *
 * - **Observe.** A strategy reports spend only through `recordCost`, and only
 *   as a *cumulative total for the physical run so far*, never a delta. Native
 *   subagents pass each turn's run-cumulative `totalCostUsd`
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
 *   `params.recordCost` — the parent-side callback *adds* into the parent's
 *   usage totals, so a second commit is double-billing and a missed one is
 *   under-billing. The in-band single-cycle path has exactly one observation
 *   per physical attempt and forwards it to its caller's `onCost` once; there
 *   is no multi-observation in-band path, hence no retention layer there.
 * - **Failure path (workflow).** A failed run settles from the checkpoint
 *   journal; if settlement itself fails, that spend stays unbilled and must be
 *   warned about loudly — never silently, and never masking the run error.
 *   Live observations already retained remain committed.
 * - **Agent-CLI children** wire no cost observer by design: their spend is
 *   external (the user's own claude/codex subscription), not TeXRA-billed
 *   USD. A future cost-reporting CLI must observe through this same
 *   cumulative discipline rather than adding a parallel channel.
 */
export interface ChildRunPorts {
  notify(update: SubagentProgressUpdate): void;
  recordCost(totalCostUsd: number | undefined): void;
}

/**
 * A child run's reported terminal outcome. A report, not a verdict: the
 * stream phase owns the terminal outcome, so an explicit stop/kill that
 * already landed CANCELLED outranks a non-zero exit this reports.
 */
type ChildRunOutcome =
  | { kind: 'completed' }
  | { kind: 'failed'; error?: unknown; errorMessage?: string }
  | { kind: 'cancelled' };

/**
 * Presentation/lifecycle port for agent-CLI child streams. The concrete
 * tool-layer stream satisfies this structurally, but the generic driver
 * declares the handful of hooks it needs here so it never imports a concrete
 * tools type. Native strategies have no stream tab of their own and omit it
 * entirely — `executeAgent`/`resumeToolUseFromResumeData` own handle creation,
 * tracking, and terminal finalization for every turn via `runFlowWithLifecycle`.
 */
interface ChildStreamPort {
  readonly logger: AgentTrace;
  /** The child loop is idle and waiting for the next follow-up instruction. */
  waitForInput(): void;
  /** The child loop has started processing a turn. */
  beginTurn(): void;
  /** The active turn failed; preserve explicit user stops. */
  failTurn(): void;
  /**
   * Complete the child stream lifecycle through the owning execution handle.
   * Resolves once the shared terminal finalizer has persisted, settled, and
   * untracked.
   */
  finalize(options?: {
    outcome?: ChildRunOutcome;
    /** Session stage closed with the derived outcome (the loop's stage). */
    stage?: Pick<StageHandle, 'end'>;
    /** Durable execution-state action; background bash owns its richer block. */
    persistence?: RunTerminalPersistence;
  }): Promise<void>;
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
export interface ChildRunStrategy<TTurn> {
  /** Stage label opened on the child trace (e.g. "Codex session"). */
  readonly stageLabel: string;

  /**
   * `persistOnly` records the terminal report without routing it to a parent.
   * Used when a headless caller awaits and reads that report itself. Omitted
   * strategies deliver normally.
   */
  readonly deliveryMode?: 'persistOnly';

  /** Produce the first turn's outcome. Throws on hard failure. */
  launch(
    ports: ChildRunPorts,
    abortController: AbortController,
  ): Promise<TTurn>;

  /**
   * Produce the next turn's outcome from the queued follow-up batch. Throws
   * on hard failure. Omitted by strategies whose first (and only) turn is
   * always terminal (workflow-script) — the loop never calls `runTurn` in
   * that case, since it only continues past a non-terminal turn. The native
   * subagent strategy declares `runTurn` unconditionally, even for a
   * workflow-category child — it is simply unreachable there, since
   * `isTerminal` is always true on that child's first turn.
   */
  runTurn?(
    followUps: readonly FollowUpQueueBatchItem[],
    ports: ChildRunPorts,
    abortController: AbortController,
  ): Promise<TTurn>;

  /** True when `turn` ends this child's run — no further turns follow. */
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
   * report so `/executions/{id}/result` reflects the latest turn — called for
   * both success and failure (`turn` is null when the call threw, `isError`
   * is set for both a throw and a non-throwing application-level failure) so
   * a failure overwrites any earlier interim-success manifest instead of
   * leaving it stale. Native strategies provide one per turn; agent-CLI
   * strategies omit it — they have no chaining-manifest contract.
   */
  buildResultMeta?(
    turn: TTurn | null,
    isError: boolean,
    wallTimeMs: number,
    /**
     * The thrown error of a failed turn, when the failure was a throw rather
     * than a returned failed result — so the manifest can carry the failure
     * message even when no flow result exists to carry it.
     */
    error?: unknown,
  ): ResultMeta | undefined | Promise<ResultMeta | undefined>;

  /**
   * Where a turn's delivery should be sent. Defaults to the run's static
   * `parentStreamId` when omitted. Native strategies track the live run
   * handle's `deliveryTargetStreamId`, which goes `undefined` once the child
   * is detached from its orchestrator (see `AgentExecutionHandle.detach`), so
   * a detached child's results stop routing to the old parent.
   */
  resolveDeliveryTarget?(): StreamTabId | undefined;

  /**
   * Release provider-owned registry entries. The loop calls this exactly once,
   * before failed/interrupted parent delivery or during finalization.
   */
  releaseSessionOwnership?(): void;
}

export interface ChildRunLoopParams<TTurn> {
  /**
   * Presentation/lifecycle wrapper for agent-CLI child streams. Native
   * strategies omit this — `executeAgent`/`resumeToolUseFromResumeData`
   * already own handle creation, tracking, and terminal finalization for
   * every turn via `runFlowWithLifecycle`, so there is no separate stream tab
   * for this loop to finalize.
   */
  readonly childStream?: ChildStreamPort;
  /**
   * The child's stream id, known deterministically upfront by every caller
   * (agent-CLI: `createChildStream`'s own id; native: `getStreamTabId` — the
   * same formula `buildAgentLaunchContext` derives internally) — never
   * discovered mid-flight, so the loop can acquire the follow-up queue and
   * attach its interrupt handler before the first turn ever runs when a handle
   * already exists.
   */
  readonly childStreamId: StreamTabId;
  readonly parentStreamId: StreamTabId;
  readonly executionId: ExecutionId;
  readonly agentName: string;
  readonly strategy: ChildRunStrategy<TTurn>;
  /**
   * Roll this child's final cost into the parent's usage totals. Omitted by
   * agent-CLI callers (no cost concept today); native delegation passes its
   * captured `recordSubagentCost` closure.
   */
  readonly recordCost?: (
    totalCostUsd: number | undefined,
  ) => void | Promise<void>;
  /**
   * Gate every turn through the session's shared child-run budget
   * (`childRunBudgetFor`). Set by the detached native/workflow launch path;
   * agent-CLI callers omit it — their children are external processes on the
   * user's own subscription, outside both the cost contract and the budget
   * (see `docs/proposals/2026-08-15-child-run-concurrency-budget.md`).
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
   * Hands an awaiting caller each settled turn's facts in memory — the
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
}

export interface ChildRunLoopHandle {
  /** Settles after terminal delivery, finalization, and artifact release. */
  readonly completion: Promise<void>;
}

/**
 * Interrupt handler attached to the child's execution handle for the child's
 * whole lifetime, so the stop button always finds a live target — including
 * the inter-turn WAITING gap, when no flow-owned context is attached.
 *
 * Does NOT implement the session duck-type (no `session.appendFollowUp`), so
 * flow-only commands such as context compaction ignore it. Follow-ups route
 * through the queue-owned submission path, which joins this loop's live lease
 * instead of creating a competing continuation.
 *
 * `interrupt()` additionally delegates into a live native turn's flow
 * context, when one is currently attached. `handle.getToolUseFlow()` is the
 * one place a currently-running turn's real interrupt reaches.
 */
class ChildRunInterruptible implements ExecutionInterruptHandler {
  private readonly controller = new AbortController();
  private queue: FollowUpQueue | null = null;
  private turnAbortController: AbortController | null = null;

  constructor(
    private readonly session: SessionHandle,
    private readonly childStreamId: StreamTabId,
  ) {}

  interrupt(): void {
    this.controller.abort();
    this.queue?.cancelWait();
    this.turnAbortController?.abort();
    const handle = this.session.executions.getAgentHandleByStream(
      this.childStreamId,
    );
    handle?.getToolUseFlow()?.interrupt();
  }

  setQueue(q: FollowUpQueue): void {
    this.queue = q;
  }

  isInterrupted(): boolean {
    return this.controller.signal.aborted;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  startTurn(): AbortController {
    this.turnAbortController = new AbortController();
    return this.turnAbortController;
  }

  finishTurn(): void {
    this.turnAbortController = null;
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
async function attemptTurn<TTurn>(
  strategy: ChildRunStrategy<TTurn>,
  runner: (abortController: AbortController) => Promise<TTurn>,
  loop: ChildRunInterruptible,
  logger: AgentTrace,
  abortController: AbortController,
  startedAt: number,
): Promise<TurnAttempt<TTurn>> {
  try {
    const turn = await runner(abortController);
    logTurnSummary(logger, Date.now() - startedAt, strategy.getUsage?.(turn));
    const turnIsError = strategy.isTurnError?.(turn) === true;
    if (turnIsError) {
      strategy.onTurnError?.(turn, logger);
    }
    return { kind: 'completed', turn, turnIsError };
  } catch (caught) {
    // A clean, caller-initiated interruption maps to `interrupted`.
    if (
      abortController.signal.aborted ||
      loop.isInterrupted() ||
      isUserAbort(caught)
    ) {
      return { kind: 'interrupted' };
    }
    logger.error(toErrorMessage(caught));
    return { kind: 'failed', err: caught };
  } finally {
    loop.finishTurn();
  }
}

/**
 * Mint the logical identity of one accepted child turn (#9531): a stable turn
 * token plus the delivery id the turn's single parent delivery is admitted
 * under. Stable within one child-run attempt and distinct across attempts,
 * even when a workflow deliberately reuses its execution ID. A producer
 * replaying the same accepted turn therefore presents the same id, while a
 * later workflow run cannot collide with its prior delivery.
 */
function mintChildTurnRef(
  executionId: ExecutionId,
  generationId: string,
  turnIndex: number,
): ChildTurnRef {
  const token = `${executionId}:generation:${generationId}:turn:${turnIndex}`;
  return { token, deliveryId: `${token}:delivery` };
}

/**
 * Why the child-run loop stopped, for the structured termination diagnostic.
 */
type ChildLoopTerminationCause = 'interrupted' | 'turn_failed' | 'terminal';

/**
 * Resolve the loop's termination cause without a nested ternary.
 */
function resolveLoopTerminationCause(
  interrupted: boolean,
  turnFailed: boolean,
): ChildLoopTerminationCause {
  if (interrupted) return 'interrupted';
  if (turnFailed) return 'turn_failed';
  return 'terminal';
}

/**
 * Structured turn-lifecycle diagnostic (#9531): ties the execution, the turn's
 * logical identity, the follow-up queue owner/generation, and the interruption
 * cause into one event so a resumed/interrupted child's state is auditable.
 * Emitted at turn acceptance, delivery, and loop termination.
 */
function emitTurnDiagnostic(
  logger: AgentTrace,
  event: 'turn.accepted' | 'turn.delivered' | 'loop.terminated',
  params: {
    executionId: ExecutionId;
    turnRef?: ChildTurnRef;
    queueOwner?: FollowUpConsumerLease;
    interruptionCause?: ChildLoopTerminationCause;
  },
): void {
  const { executionId, turnRef, queueOwner, interruptionCause } = params;
  logger.info(`childRunLoop ${event}`, {
    data: {
      executionId,
      ...(turnRef
        ? { turnToken: turnRef.token, deliveryId: turnRef.deliveryId }
        : {}),
      ...(queueOwner
        ? {
            queueGeneration: queueOwner.generation,
            queueOwner: queueOwner.kind,
          }
        : {}),
      ...(interruptionCause ? { interruptionCause } : {}),
    },
  });
}

/**
 * Persist turn attribution for the report/result slots, swallowing storage
 * errors. Best-effort: a failure degrades /report//result turn labeling, not
 * the delivered result.
 */
async function persistTurnStateBestEffort(
  executionId: ExecutionId,
  state: ChildTurnState,
  logger: AgentTrace,
): Promise<void> {
  try {
    await getExecutionStore(executionId).writeTurnState(state);
  } catch (err) {
    logger.warn(`Failed to persist turn state for ${executionId}`, {
      data: err,
    });
  }
}

/**
 * Where this turn's output goes. A strategy without `resolveDeliveryTarget`
 * (agent-CLI) always delivers to the run's static parent. A strategy that HAS
 * one (native) may return `undefined` — meaning the child was detached from its
 * orchestrator (see `AgentExecutionHandle.detach`) — which must skip delivery
 * entirely, not silently fall back to the old parent.
 */
function resolveDeliveryTarget<TTurn>(
  strategy: ChildRunStrategy<TTurn>,
  parentStreamId: StreamTabId,
): StreamTabId | undefined {
  return strategy.resolveDeliveryTarget
    ? strategy.resolveDeliveryTarget()
    : parentStreamId;
}

/**
 * A turn's parent-follow-up enqueue, still pending its wake step. Waking can
 * await the resumed parent's entire turn (`agentResume.tryResumeStream` → …
 * → `resumeToolUseFromResumeData`), so callers that are about to finalize this
 * child (terminal/failed turns) must resolve the wake only AFTER that
 * finalize completes — otherwise a resumed parent that immediately waits on
 * this still-RUNNING execution self-stalls (#8093). Callers that continue to
 * another turn (no finalize pending) may wake immediately.
 */
interface PendingChildDelivery {
  readonly targetStreamId: StreamTabId;
  readonly followUp: FollowUpQueueInput;
  readonly expectedGenerationId?: string;
}

/**
 * Format, persist, and enqueue one turn's outcome on the parent's follow-up
 * queue — the loop's single delivery site, shared by every interim and
 * terminal turn, every strategy. Returns the pending delivery for the caller
 * to wake via {@link submitPendingDelivery} once its own ordering allows it;
 * `undefined` when there is nothing to wake (detached child, or delivery
 * skipped by `prepareParentDelivery`).
 */
async function deliverTurn<TTurn>(params: {
  strategy: ChildRunStrategy<TTurn>;
  executionId: ExecutionId;
  parentStreamId: StreamTabId;
  logger: AgentTrace;
  turn: TTurn | null;
  turnRef: ChildTurnRef;
  err: unknown;
  wallTimeMs: number;
  isError: boolean;
  prepareParentDelivery?: () => boolean;
  /** Parent continuation generation captured before this producer started. */
  parentDeliveryGenerationId?: string;
  /** Serializes turn-state writes against the acceptance write (#9531). */
  turnStateWrites: PQueue;
  onTurnSettled?: ChildRunLoopParams<TTurn>['onTurnSettled'];
}): Promise<PendingChildDelivery | undefined> {
  const {
    strategy,
    executionId,
    parentStreamId,
    logger,
    turn,
    turnRef,
    err,
    wallTimeMs,
    isError,
    prepareParentDelivery,
    parentDeliveryGenerationId,
  } = params;
  const delivered = turn != null && !isError;
  const msg = await (delivered
    ? strategy.formatDelivery(turn, wallTimeMs)
    : strategy.formatError(turn, err));
  // Called for both success and failure — a failure must overwrite any
  // earlier interim-success manifest, not leave it stale.
  const resultMeta = await strategy.buildResultMeta?.(
    turn,
    isError,
    wallTimeMs,
    err ?? undefined,
  );
  // Attribute the envelope to this turn so /result can tell which turn the
  // latest-value slot reflects (#9531).
  const stampedMeta =
    resultMeta?.producer === 'subagent'
      ? { ...resultMeta, turnToken: turnRef.token }
      : resultMeta;

  await persistChildRunDeliveryBestEffort(
    executionId,
    msg,
    stampedMeta,
    (kind, error) => {
      logger.warn(`Failed to persist ${kind} for ${executionId}`, {
        data: error,
      });
    },
  );
  // The turn's result slots now hold this turn: record it as the latest
  // completed turn, clearing the active marker written at acceptance. The
  // store does not serialize per-key writes, so this must queue behind the
  // acceptance write — otherwise a late acceptance write can overwrite this
  // newer completion record (Cursor Bugbot on PR #9664).
  await params.turnStateWrites.add(() =>
    persistTurnStateBestEffort(
      executionId,
      { lastCompletedTurn: turnRef },
      logger,
    ),
  );

  params.onTurnSettled?.({
    message: msg,
    ...(stampedMeta !== undefined && { resultMeta: stampedMeta }),
    isError,
    ...(err != null && { error: err }),
  });

  if (strategy.deliveryMode === 'persistOnly') return undefined;

  const targetStreamId = resolveDeliveryTarget(strategy, parentStreamId);
  if (!targetStreamId) {
    logger.warn(
      'Turn result not delivered: child was detached from its orchestrator. The result remains in the execution report.',
      { data: { executionId } },
    );
    return undefined;
  }
  if (prepareParentDelivery?.() === false) return undefined;
  return {
    targetStreamId,
    ...(parentDeliveryGenerationId !== undefined
      ? { expectedGenerationId: parentDeliveryGenerationId }
      : {}),
    followUp: {
      text: msg,
      origin: 'subagent_result',
      deliveryId: turnRef.deliveryId,
    },
  };
}

/**
 * Resolve a pending delivery's wake step (no-op when there is nothing to
 * wake, or the enqueue itself found no session — already logged above).
 */
async function submitPendingDelivery(
  pending: PendingChildDelivery | undefined,
  session: SessionHandle,
  executionId: ExecutionId,
  logger: AgentTrace,
): Promise<void> {
  if (!pending) return;
  const delivery = await deliverChildRunFollowUp({
    targetStreamId: pending.targetStreamId,
    followUp: pending.followUp,
    session,
    ...(pending.expectedGenerationId !== undefined
      ? { expectedGenerationId: pending.expectedGenerationId }
      : {}),
  });
  if (delivery.kind !== 'delivered') {
    logger.warn(
      'Turn result not delivered: parent stream is unavailable. The result remains in the execution report.',
      {
        data: {
          executionId,
          parentStreamId: pending.targetStreamId,
          ...(delivery.kind === 'no_session' && {
            streamStatus: delivery.streamStatus ?? 'unknown',
          }),
        },
      },
    );
  }
}

/**
 * Drive a child run: the initial turn goes through `strategy.launch`, then
 * every following turn is drained from the child's follow-up queue and run
 * through `strategy.runTurn`. Each turn's result (or error) is delivered to
 * the parent's follow-up queue and persisted as a report; the run ends when a
 * turn is terminal, a turn fails, or the loop is interrupted.
 */
export function startChildRunLoop<TTurn>(
  params: ChildRunLoopParams<TTurn>,
): ChildRunLoopHandle {
  const {
    childStream,
    childStreamId,
    parentStreamId,
    executionId,
    agentName,
    strategy,
  } = params;
  // Agent-CLI children log to their own presentation stream; native children
  // have no stream tab of their own here (each turn already logs through its
  // own run trace inside `runFlowWithLifecycle`), so this is a channel-only
  // fallback for the loop's own turn-summary/warning lines.
  const logger = childStream?.logger ?? createChannelTrace('childRunLoop');
  // The code below is synchronous until the scoped loop task is spawned, so a
  // lost generation fails before any queue, listener, stage, or loop exists.
  captureOwnedExecutionLease(executionId);
  const runSession = currentSession();
  // Parent delivery belongs to the continuation generation under which this
  // producer started. A terminal retry may reuse the same stream ID, but late
  // progress or results from this child must not enter the replacement queue.
  const parentDeliveryGenerationId =
    runSession.followUps.currentGenerationId(parentStreamId);
  const releaseChildActivation = childStream
    ? () => undefined
    : runSession.executions.reserveChildActivation({
        executionId,
        parentStreamId,
        childStreamId,
      });
  let sessionOwnershipReleased = false;
  const releaseSessionOwnershipOnce = (): void => {
    if (sessionOwnershipReleased) return;
    sessionOwnershipReleased = true;
    strategy.releaseSessionOwnership?.();
  };

  const loop = new ChildRunInterruptible(runSession, childStreamId);
  let stopWatchingLease: (() => void) | undefined;
  let queue!: FollowUpQueue;
  let queueLease: FollowUpConsumerLease | undefined;
  let attachedHandle: AgentExecutionHandle | undefined;
  let detachLoopInterrupt: (() => void) | undefined;
  const attachLoopInterrupt = (): void => {
    const handle = runSession.executions.getAgentHandleByStream(childStreamId);
    if (!handle || handle === attachedHandle) return;
    detachLoopInterrupt?.();
    attachedHandle = handle;
    detachLoopInterrupt = handle.attachInterruptHandler(loop);
  };
  let sessionStage: StageHandle | undefined;

  try {
    strategy.onLoopStart?.(runSession);
    stopWatchingLease = onOwnedExecutionLeaseLost(executionId, () => {
      logger.error('Execution lease was lost; interrupting the former owner', {
        data: { executionId, childStreamId },
      });
      loop.interrupt();
    });
    // Revalidate at the state transition itself: setup hooks above may run
    // arbitrary synchronous code after the early fail-fast lease check.
    captureOwnedExecutionLease(executionId);
    queueLease = runSession.followUps.claimChildRun(childStreamId, executionId);
    if (!queueLease) {
      throw new Error(
        `Follow-up continuation already has an owner for child ${childStreamId}.`,
      );
    }
    queue = runSession.followUps.queue(queueLease);
    loop.setQueue(queue);
    attachLoopInterrupt();
    sessionStage = childStream
      ? logger.openStage(strategy.stageLabel)
      : undefined;
  } catch (error) {
    // Preserve the setup error while unwinding every resource acquired so far.
    const cleanupErrors: unknown[] = [];
    const cleanup = (operation: () => void): void => {
      try {
        operation();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    };
    cleanup(() => sessionStage?.end(RUN_OUTCOME.FAILED));
    cleanup(() => detachLoopInterrupt?.());
    cleanup(() => {
      if (queueLease) runSession.followUps.release(queueLease, 'terminal');
    });
    cleanup(() => stopWatchingLease?.());
    cleanup(releaseChildActivation);
    cleanup(releaseSessionOwnershipOnce);
    // The primary error always heads the list, so a single throw covers both
    // shapes: `error` unwrapped when rollback was clean, an AggregateError when
    // cleanup also failed.
    throw aggregateError(
      [error, ...cleanupErrors],
      `Child run ${executionId} setup failed and rollback was incomplete`,
    );
  }

  const childRunGenerationId = queueLease.generationId;

  let bestCostUsd: number | undefined;
  const ports: ChildRunPorts = {
    notify: (update) => {
      if (params.notify) {
        params.notify(update);
        return;
      }
      if (strategy.deliveryMode === 'persistOnly') return;
      const targetStreamId = resolveDeliveryTarget(strategy, parentStreamId);
      if (!targetStreamId) return;
      const msg = formatSubagentProgress(executionId, agentName, update);
      void deliverChildRunFollowUp({
        targetStreamId,
        followUp: { text: msg, origin: 'subagent_result' },
        session: runSession,
        mode: 'live_notification',
        ...(parentDeliveryGenerationId !== undefined
          ? { expectedGenerationId: parentDeliveryGenerationId }
          : {}),
      });
    },
    recordCost: (totalCostUsd) => {
      if (totalCostUsd !== undefined) {
        bestCostUsd = Math.max(bestCostUsd ?? 0, totalCostUsd);
      }
    },
  };

  let sawTurnFailure = false;
  let lastTurnErr: unknown;
  // A delivery whose wake is still pending. Set right before any `break` out
  // of the loop below (terminal/failed turn) and resolved AFTER this child's
  // own finalize in the `finally` block — never before — so a resumed parent
  // that immediately waits on this execution always finds it terminal
  // (#8093). Interim (non-terminal) turns wake inline, immediately, since no
  // finalize is pending for them.
  let pendingDelivery: PendingChildDelivery | undefined;
  // One slot per live turn: acquired here — the single boundary that drives
  // every detached native child turn — and nowhere above or below (design:
  // docs/proposals/2026-08-15-child-run-concurrency-budget.md).
  const budget = params.budgeted ? childRunBudgetFor(runSession) : undefined;
  const gateTurn = (
    base: (ac: AbortController) => Promise<TTurn>,
  ): ((ac: AbortController) => Promise<TTurn>) =>
    budget === undefined
      ? base
      : (ac) =>
          budget.add(() => {
            // A turn cancelled while awaiting a slot must not start fresh
            // model work; the loop classifies this throw as interrupted.
            if (loop.isInterrupted() || ac.signal.aborted) {
              throw new Error(
                'Child run turn cancelled while awaiting a concurrency slot.',
              );
            }
            return base(ac);
          }) as Promise<TTurn>;

  const run = async (): Promise<void> => {
    let runner: (ac: AbortController) => Promise<TTurn> = (ac) =>
      strategy.launch(ports, ac);
    // Turn identity (#9531): each accepted turn mints a stable token/delivery
    // id and records itself active before running; the latest completed turn
    // is carried forward so an interrupted turn never overwrites it.
    let turnIndex = 0;
    let lastCompletedTurn: ChildTurnRef | undefined;
    // KVStore does not serialize per-key writes: queue turn-state writes so
    // the fire-and-forget acceptance write cannot land after the completion
    // record deliverTurn writes for the same turn.
    const turnStateWrites = new PQueue({ concurrency: 1 });
    try {
      while (!loop.isInterrupted()) {
        turnIndex += 1;
        const turnRef = mintChildTurnRef(
          executionId,
          childRunGenerationId,
          turnIndex,
        );
        emitTurnDiagnostic(logger, 'turn.accepted', {
          executionId,
          turnRef,
          queueOwner: queueLease,
        });
        // Acceptance creates the pending-turn record: until this turn's
        // result is persisted, /report and /result keep attributing the
        // latest-value slots to the last completed turn. Fire-and-forget —
        // the first turn must still reach strategy.launch synchronously; the
        // queue (not the store) guarantees it lands before the completion
        // record deliverTurn writes later.
        void turnStateWrites.add(() =>
          persistTurnStateBestEffort(
            executionId,
            { activeTurn: turnRef, lastCompletedTurn },
            logger,
          ),
        );
        const startedAt = Date.now();
        const abortController = loop.startTurn();
        const attempt = await attemptTurn(
          strategy,
          gateTurn(runner),
          loop,
          logger,
          abortController,
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

        const delivery = await deliverTurn({
          strategy,
          executionId,
          parentStreamId,
          parentDeliveryGenerationId,
          logger,
          turn,
          turnRef,
          err,
          wallTimeMs,
          isError: turnFailed,
          turnStateWrites,
          onTurnSettled: params.onTurnSettled,
          prepareParentDelivery: () => {
            if (loop.isInterrupted()) {
              releaseSessionOwnershipOnce();
              return false;
            }
            if (turnFailed) {
              releaseSessionOwnershipOnce();
            } else if (turn != null) {
              strategy.onTurnSuccess?.(turn, runSession);
            }
            return true;
          },
        });
        lastCompletedTurn = turnRef;
        emitTurnDiagnostic(logger, 'turn.delivered', {
          executionId,
          turnRef,
          queueOwner: queueLease,
        });

        if (turnFailed) {
          sawTurnFailure = true;
          lastTurnErr =
            err ??
            new Error(
              `${strategy.stageLabel} reported a failed turn without throwing.`,
            );
          childStream?.failTurn();
          pendingDelivery = delivery;
          break;
        }

        const isTerminal = turn != null && strategy.isTerminal(turn);
        if (isTerminal || !strategy.runTurn) {
          // A strategy without `runTurn` (workflow-script) declares every
          // turn terminal via `isTerminal`; reaching here with one still
          // undeclared-terminal is a strategy bug, not a run outcome — stop
          // rather than call an absent `runTurn`.
          pendingDelivery = delivery;
          break;
        }

        // Interim turn continuing: no finalize is pending, so wake now — the
        // loop's interrupt handler is already attached (immediately above,
        // the instant this turn settled) — then just drain the next batch. A
        // follow-up already raced into the queue resumes immediately instead
        // of genuinely waiting.
        await submitPendingDelivery(delivery, runSession, executionId, logger);
        childStream?.waitForInput();
        if (loop.isInterrupted()) break;

        const batch = await queue.waitAndDrainAll(loop.signal);
        if (!batch || loop.isInterrupted()) break;

        const nextRunTurn = strategy.runTurn;
        runner = (ac) => nextRunTurn(batch.items, ports, ac);
        childStream?.beginTurn();
      }
    } finally {
      // A retry may reuse this execution ID as soon as its lease is released.
      // Drain the prior attempt's queued attribution writes first so an old
      // acceptance record cannot land after the retry's newer turn state.
      await turnStateWrites.onIdle();
      detachLoopInterrupt?.();
      emitTurnDiagnostic(logger, 'loop.terminated', {
        executionId,
        queueOwner: queueLease,
        interruptionCause: resolveLoopTerminationCause(
          loop.isInterrupted(),
          sawTurnFailure,
        ),
      });
      if (queueLease) runSession.followUps.release(queueLease, 'terminal');
      releaseSessionOwnershipOnce();
      try {
        try {
          const observed = params.recordCost?.(bestCostUsd);
          void Promise.resolve(observed).catch((error: unknown) => {
            logger.warn('Child cost observer rejected', { data: error });
          });
        } catch (error) {
          logger.warn('Child cost observer failed', { data: error });
        }
        // The shared terminal finalizer owns the single outcome derivation and
        // its projections: persisted terminal status (before untrack notifies
        // waiters), settled result, and terminal stream phase.
        if (childStream) {
          // Agent-CLI: ChildStream.finalize owns this handle for the loop's
          // whole lifetime (one handle, tracked once by createChildStream).
          // A failed turn is reported with its cause even when a stop
          // followed it: the stream phase arbitrates, so a stop that landed
          // CANCELLED still outranks this report, while a failure that
          // already terminalized the phase keeps its diagnosis instead of
          // publishing FAILED with no error facts at all.
          let loopOutcome: ChildRunOutcome;
          if (sawTurnFailure) {
            loopOutcome = { kind: 'failed', error: lastTurnErr };
          } else if (loop.isInterrupted()) {
            loopOutcome = { kind: 'cancelled' };
          } else {
            loopOutcome = { kind: 'completed' };
          }
          await childStream.finalize({
            outcome: loopOutcome,
            stage: sessionStage,
            persistence: { kind: 'finalize', flowRecord: 'delete' },
          });
        } else {
          // Native: every GENUINE terminal turn already finalized its own
          // handle inside runFlowWithLifecycle (the handle is untracked by the
          // time this runs, so the lookup below finds nothing — a safe no-op).
          // Two paths leave the most recently tracked handle for this stream
          // dangling, never finalized by its own flow:
          //   (1) the loop was interrupted between turns — ExecutionRegistry
          //       .terminate() found this loop's own interrupt handler, called
          //       .interrupt(), and transitioned the stream to CANCELLED, but
          //       assumed a live flow would notice and self-finalize; nothing
          //       is running here, the loop was just blocked on a queue wait.
          //   (2) `runTurn` threw before ever reaching a new
          //       runFlowWithLifecycle call (a resume pre-check failure, or a
          //       failed resume per #7491) — the prior turn's suspended handle
          //       was never touched by this attempt.
          // `finalizeRunTerminal`'s atomic claim makes this call safe even if
          // it races something else that already finalized the same handle.
          const handle =
            runSession.executions.getAgentHandleByStream(childStreamId);
          if (handle) {
            const outcome = deriveRunOutcome({
              failed: sawTurnFailure && !loop.isInterrupted(),
              cancelled: loop.isInterrupted(),
            });
            await finalizeRunTerminal({
              handle,
              executions: runSession.executions,
              streamStatus: runSession.status,
              outcome,
              error:
                sawTurnFailure && lastTurnErr !== undefined
                  ? {
                      kind: classifyAgentError(lastTurnErr),
                      message: toErrorMessage(lastTurnErr),
                    }
                  : undefined,
              isSubagent: handle.isChildExecution,
              flushArtifacts: () =>
                runSession.flushArtifacts(handle.executionId),
              persistence: {
                kind: 'finalize',
                // Keyed on the outcome the finalizer resolves, not this loop's
                // report: only a genuinely interrupted run leaves state worth
                // resuming, and the phase is what decides which run that is.
                flowRecord: (resolved) =>
                  resolved === RUN_OUTCOME.CANCELLED ? 'preserve' : 'delete',
              },
            });
          }
        }
        // Wake the parent only now — after this child's own finalize above —
        // so a resumed parent turn that immediately waits on this execution
        // (e.g. `executions` tool with `action=wait`) always observes it
        // terminal instead of racing its own wake (#8093).
        await submitPendingDelivery(
          pendingDelivery,
          runSession,
          executionId,
          logger,
        );
      } finally {
        try {
          await runSession.releaseExecutionLease(executionId);
        } catch (error) {
          logger.warn('Failed to persist final child-run artifacts', {
            data: { executionId, error },
          });
        } finally {
          stopWatchingLease?.();
          releaseChildActivation();
        }
      }
    }
  };
  try {
    const completion = Promise.resolve(
      captureOwnedExecutionLease(executionId)(run),
    );
    return { completion };
  } catch (error) {
    releaseChildActivation();
    throw error;
  }
}
