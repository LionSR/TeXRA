/**
 * The one resume entry point. Every host continues a persisted run through
 * it: the extension toolbar, the desktop bridge, the CLI `/resume` command and
 * `texra resume`, and the implicit follow-up wake. It resolves persisted
 * state, claims the stream's follow-up recovery lease, and launches the run
 * as a generation on its execution lane (`resumeToolUseFromResumeData` for
 * tool-use, the host's workflow launcher for workflows). The native child
 * loop keeps the unlaned `resumeToolUseTurn`: it already holds the lane.
 */
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type {
  FollowUpQueueBatchItem,
  FollowUpQueueInput,
} from '@agent/followUp/FollowUpQueue';
import {
  lookupStreamExecutionId,
  type FollowUpFailureReason,
} from '@agent/followUp/ToolUseFollowUp';
import type { FollowUpRecoveryLease } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { ExecutionLeaseActiveError } from '@agent/storage/executionLease';
import { getExecutionStore } from '@agent/storage/ExecutionKVStore';
import { readExecutionMeta } from '@agent/storage/executionMetaPersistence';
import type { RecoveryContinuation } from '@platform/interfaces';
import {
  AgentCategory,
  STREAM_PHASE,
  STREAM_SUBSTATE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';

import {
  isWaitingFlowResult,
  type AgentRuntimeFlowResult,
} from './AgentFlowResult';
import {
  ResumeSessionUnavailableError,
  resumeToolUseFromResumeData,
  type SubagentRunOptions,
} from './executeAgent';
import {
  retrieveSessionResumeData,
  type ToolUseResumeData,
} from './SessionResumeRetrieval';
import { defaultSession, type SessionHandle } from './SessionHandle';
import type { ModelHandlerCompatibilityKey } from './modelHandlerCompatibilityKey';

/**
 * `started` once the resumed generation has settled (a tool-use turn parked
 * at WAITING or finished; a workflow run returned). `delivered` is false when
 * that generation returned but its drained follow-up batch was replayed onto
 * the stream queue instead of being consumed: the input still awaits
 * delivery, so a follow-up wake reports it as queued while an explicit resume
 * settles the turn it just ran. A refusal carries the reason a host words
 * with `describeFollowUpFailure`. Unexpected failures (storage errors, the
 * run itself throwing) reject.
 */
export type ResumeRunResult =
  | { readonly started: true; readonly delivered: boolean }
  | { readonly failed: FollowUpFailureReason };

export interface ResumeRunOptions extends Pick<
  SubagentRunOptions,
  | 'session'
  | 'approvalPromptsUnavailable'
  | 'onApprovalPolicyDenial'
  | 'runtimeUnavailableTools'
> {
  /** Recovery ownership synchronously claimed by the submission boundary. */
  readonly recovery?: RecoveryContinuation;
  /** Monotone per-attempt cancellation signal: once true it stays true. */
  readonly isCancellationRequested?: () => boolean;
  /**
   * Follow-ups to replay ahead of any items already queued for the stream
   * (e.g. an explicit follow-up typed alongside a manual resume). Seeded
   * before the drain so the failure path re-enqueues them even if the drain
   * throws before the full list is assigned.
   *
   * The batch stays the caller's until {@link onFollowUpQueueReady} fires:
   * every refusal before that point returns it unqueued, and the caller must
   * put it back where it came from or the user's input is lost. Once the
   * queue owns it, a replay lands on the stream queue (`delivered: false`)
   * rather than back with the caller.
   */
  readonly extraFollowUps?: readonly FollowUpQueueInput[];
  /**
   * Fires after the shared stream queue is acquired and marked RESUMING, but
   * before its queued items are drained into the rebuilt session. This is the
   * one signal that the queue has taken ownership of `extraFollowUps`.
   */
  readonly onFollowUpQueueReady?: (recovery: FollowUpRecoveryLease) => void;
  /**
   * Fires with the resumed tool-use run's raw outcome (terminal or WAITING)
   * right before `'started'` is returned.
   */
  readonly onResult?: (result: AgentRuntimeFlowResult) => void;
  /**
   * Workflow launch owns stream acquisition and status transitions through
   * `runAgent`; each host supplies its own launcher.
   */
  readonly executeWorkflow: (
    config: AgentConfig,
    executionId: ExecutionId,
    modelHandlerCompatibilityKey:
      ModelHandlerCompatibilityKey | null | undefined,
  ) => Promise<void>;
}

/**
 * Resume a stream through the single host entry path. Recovery is claimed
 * synchronously, before the stream-to-execution index can perform disk I/O.
 */
export async function resumeStream(
  streamId: StreamTabId,
  options: ResumeRunOptions,
): Promise<ResumeRunResult> {
  const session = options.session ?? defaultSession();
  if (
    options.isCancellationRequested?.() === true ||
    session.executions.isActiveOrResuming(streamId)
  ) {
    return REFUSED;
  }

  const recovery = options.recovery
    ? session.followUps.useRecovery(options.recovery)
    : session.followUps.claimRecovery(streamId, true);
  if (!recovery || recovery.streamId !== streamId) {
    if (recovery) session.followUps.release(recovery, 'recoverable');
    return REFUSED;
  }

  try {
    const executionId = await lookupStreamExecutionId(streamId, session);
    if (!executionId) {
      releaseUnstartedRecovery(session, recovery, options.recovery == null);
      return REFUSED;
    }
    return resumeRunWithRecoveryProvenance(
      executionId,
      { ...options, session, recovery },
      options.recovery == null,
    );
  } catch (error) {
    releaseUnstartedRecovery(session, recovery, options.recovery == null);
    throw error;
  }
}

export { lookupStreamExecutionId } from '@agent/followUp/ToolUseFollowUp';

const REFUSED: ResumeRunResult = { failed: 'not_resumable' };
/** A workflow run carries no follow-up batch, so nothing awaits delivery. */
const WORKFLOW_STARTED: ResumeRunResult = { started: true, delivered: true };

export async function resumeRun(
  executionId: ExecutionId,
  options: ResumeRunOptions,
): Promise<ResumeRunResult> {
  return resumeRunWithRecoveryProvenance(executionId, options, false);
}

async function resumeRunWithRecoveryProvenance(
  executionId: ExecutionId,
  options: ResumeRunOptions,
  recoveryIsProvisional: boolean,
): Promise<ResumeRunResult> {
  const session = options.session ?? defaultSession();
  const isCancellationRequested = (): boolean =>
    options.isCancellationRequested?.() === true;

  const suppliedRecovery = options.recovery
    ? session.followUps.useRecovery(options.recovery)
    : undefined;
  /** Give the caller-supplied recovery back on every path that never starts. */
  const abandonSupplied = (provisional = recoveryIsProvisional): void => {
    if (suppliedRecovery) {
      releaseUnstartedRecovery(session, suppliedRecovery, provisional);
    }
  };

  const store = getExecutionStore(executionId);
  let config: Awaited<ReturnType<typeof store.readConfig>>;
  let meta: Awaited<ReturnType<typeof store.readMeta>>;
  let streamId: StreamTabId | undefined;
  try {
    [config, meta] = await Promise.all([
      store.readConfig(),
      readExecutionMeta(executionId),
    ]);
    streamId = meta?.streamId;
  } catch (error) {
    abandonSupplied();
    throw error;
  }
  // FK-first: current rows use the registration edge directly. A historical
  // row gets only the unique, confirmed sidecar recovery above.
  if (!config || !streamId) {
    abandonSupplied();
    return REFUSED;
  }
  if (suppliedRecovery && suppliedRecovery.streamId !== streamId) {
    // A stream mismatch is never provisional: the entry belongs to another
    // stream, so it stays recoverable there.
    abandonSupplied(false);
    return REFUSED;
  }
  // A stream that is already running or resuming in this process is refused,
  // not queued on the lane: a workflow run holds no follow-up queue consumer
  // and a queued resume would otherwise rerun it after it finishes.
  if (
    isCancellationRequested() ||
    session.executions.isActiveOrResuming(streamId)
  ) {
    abandonSupplied();
    return REFUSED;
  }

  // Claim recovery before the asynchronous retrieval: a follow-up submitted
  // meanwhile joins this resume's queue instead of starting a second one.
  let queueLease: FollowUpRecoveryLease | undefined;
  if (config.agentCategory === AgentCategory.ToolUse) {
    queueLease = options.recovery
      ? session.followUps.useRecovery(options.recovery)
      : session.followUps.claimRecovery(streamId, true);
    if (!queueLease) return REFUSED;
  } else {
    // Workflow runs have no follow-up consumer. An empty entry created only
    // for lookup can be terminalized; caller-supplied or raced input remains
    // recoverable so no user message or release observer is lost.
    abandonSupplied();
  }

  let resume: Awaited<ReturnType<typeof retrieveSessionResumeData>>;
  try {
    const snapshots = session.snapshots;
    if (
      snapshots.getRunMetadata(streamId, { quiet: true }).executionId ===
      undefined
    ) {
      await snapshots.preload([streamId]);
    }
    resume = await retrieveSessionResumeData(streamId, executionId, config, {
      parentStreamId: snapshots.getParentStreamId(streamId),
    });
  } catch (error) {
    if (queueLease) session.followUps.release(queueLease, 'recoverable');
    throw error;
  }
  if (
    isCancellationRequested() ||
    // Re-check after the retrieval await: a launch of this stream may have
    // been admitted meanwhile, and the lane would queue, not refuse, this one.
    session.executions.isActiveOrResuming(streamId)
  ) {
    if (queueLease) session.followUps.release(queueLease, 'recoverable');
    return REFUSED;
  }
  if (!resume) {
    if (queueLease) session.followUps.release(queueLease, 'recoverable');
    return { failed: 'finished' };
  }
  if (resume.type === 'toolUse' && queueLease) {
    return resumeQueuedToolUse(session, resume, queueLease, options);
  }
  if (resume.type === 'workflow' && !queueLease) {
    try {
      await options.executeWorkflow(
        resume.agentConfig,
        resume.executionId,
        resume.modelHandlerCompatibilityKey,
      );
    } catch (error) {
      return refusalFor(error) ?? Promise.reject(error);
    }
    return WORKFLOW_STARTED;
  }
  // The persisted config and checkpoint disagree on the category.
  if (queueLease) session.followUps.release(queueLease, 'recoverable');
  return REFUSED;
}

function releaseUnstartedRecovery(
  session: SessionHandle,
  recovery: FollowUpRecoveryLease,
  provisional: boolean,
): void {
  const current = session.followUps.useRecovery(recovery);
  if (!current) return;
  if (provisional && session.followUps.queue(current).isEmpty()) {
    session.followUps.terminalize(current.streamId);
    return;
  }
  session.followUps.release(current, 'recoverable');
}

/** The two expected launch failures a host words; anything else rejects. */
function refusalFor(error: unknown): ResumeRunResult | undefined {
  if (error instanceof ExecutionLeaseActiveError) {
    return { failed: 'owned_elsewhere' };
  }
  if (error instanceof ResumeSessionUnavailableError) {
    return { failed: 'finished' };
  }
  return undefined;
}

/**
 * The tool-use resume "queue dance": flip the stream to RESUMING, drain the
 * queued follow-ups and notify the UI, resume while handing the drained batch
 * to the flow's WAITING cursor via `drainedFollowUps`, on failure re-enqueue
 * the follow-ups and re-notify, and always return the stream to WAITING if
 * the resume never reached the run lifecycle.
 */
async function resumeQueuedToolUse(
  session: SessionHandle,
  resume: ToolUseResumeData,
  queueLease: FollowUpRecoveryLease,
  options: ResumeRunOptions,
): Promise<ResumeRunResult> {
  const { streamId } = resume;
  const streamStatus = session.status;
  const followUpsQueue = session.followUps;

  if (
    session.executions.getHandle(resume.executionId)
      ?.suspendedTerminationStarted
  ) {
    followUpsQueue.release(queueLease, 'recoverable');
    return REFUSED;
  }
  streamStatus.transition(streamId, STREAM_PHASE.RUNNING, 'resume', {
    substate: STREAM_SUBSTATE.RESUMING,
  });

  const seed = options.extraFollowUps ?? [];
  let followUps: readonly FollowUpQueueInput[] = seed;
  let cancelledAtFlowAttachment = false;
  let followUpsRestored = false;
  let resumeError: { error: unknown } | undefined;
  let runResult: AgentRuntimeFlowResult | undefined;
  const notifyQueued = (): void => {
    session.events.emit({
      scope: 'session',
      event: { type: 'updateQueuedFollowUps', payload: { streamId } },
    });
  };
  const restoreFollowUps = (): void => {
    if (followUpsRestored) return;
    followUpsRestored = true;
    followUpsQueue.queue(queueLease).restore(followUps);
    if (followUps.length > 0) notifyQueued();
  };
  try {
    options.onFollowUpQueueReady?.(queueLease);
    followUps = [...seed, ...followUpsQueue.queue(queueLease).drainItems()];
    notifyQueued();

    // The drained batch must reach the resumed flow through the direct
    // `drainedFollowUps` handoff, not by re-queuing: a subagent's WAITING
    // cursor suspends again before ever reading the stream queue (see
    // `ToolUseWaitNode`; only its child-run loop's queue wait consumes it),
    // so re-queued items would sit unconsumed until the next wake. A root
    // cursor accepts either route; the handoff works for both.
    runResult = await resumeToolUseFromResumeData(resume, {
      session: options.session,
      approvalPromptsUnavailable: options.approvalPromptsUnavailable,
      onApprovalPolicyDenial: options.onApprovalPolicyDenial,
      runtimeUnavailableTools: options.runtimeUnavailableTools,
      parentStreamId: resume.parentStreamId,
      onFollowUpConsumed: () => {
        followUps = [];
      },
      isCancellationRequested: options.isCancellationRequested,
      onCancellationAtFlowAttachment: () => {
        cancelledAtFlowAttachment = true;
      },
      drainedFollowUps: followUps.map(toFollowUpBatchItem),
      // The first call closes the gap between the initial drain and live-flow
      // attachment. Later calls occur after a subagent parks at WAITING. A
      // native child loop owns that queue boundary when registered; otherwise
      // this host resume must claim the late batch so input accepted by the
      // live context cannot remain dormant.
      takePendingFollowUps: () => {
        const raced = followUpsQueue.queue(queueLease).drainItems();
        followUps = [...followUps, ...raced];
        return raced.map(toFollowUpBatchItem);
      },
    });
    if (followUps.length > 0) restoreFollowUps();
    options.onResult?.(runResult);
  } catch (error) {
    resumeError = { error };
    // A rejection before the wait node acknowledges consumption must replay
    // the drained batch. A callback failure after that acknowledgement must
    // not enqueue the same user input again.
    if (followUps.length > 0) restoreFollowUps();
  } finally {
    // Early failures leave the stream RESUMING. Startup cancellation can
    // instead reach lifecycle terminalization before the queue owner regains
    // control. In both cases, restored input makes WAITING the durable state.
    if (
      cancelledAtFlowAttachment ||
      followUpsRestored ||
      streamStatus.getSubstate(streamId) === STREAM_SUBSTATE.RESUMING
    ) {
      streamStatus.transitionToWaiting(streamId, 'wait');
    }
    followUpsQueue.release(
      queueLease,
      !runResult || isWaitingFlowResult(runResult) || followUpsRestored
        ? 'recoverable'
        : 'terminal',
    );
  }

  if (resumeError) {
    return refusalFor(resumeError.error) ?? Promise.reject(resumeError.error);
  }
  // Cancellation at flow attachment means the run was never reached; a replay
  // means it ran and returned with the batch back on the stream queue.
  if (cancelledAtFlowAttachment) return REFUSED;
  return { started: true, delivered: !followUpsRestored };
}

function toFollowUpBatchItem(item: FollowUpQueueInput): FollowUpQueueBatchItem {
  return {
    text: item.text,
    displayText: item.displayText,
    mediaFiles: item.mediaFiles,
    origin: item.origin ?? 'user',
  };
}
