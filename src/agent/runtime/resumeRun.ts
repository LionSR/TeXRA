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
import type { FollowUpFailureReason } from '@agent/followUp/ToolUseFollowUp';
import type { FollowUpRecoveryLease } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { ExecutionLeaseActiveError } from '@agent/storage/executionLease';
import { getExecutionStore } from '@agent/storage/ExecutionKVStore';
import type { RecoveryContinuation } from '@platform/interfaces';
import {
  AgentCategory,
  STREAM_PHASE,
  STREAM_SUBSTATE,
  type ExecutionId,
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
 * `'started'` once the resumed generation has settled (a tool-use turn
 * parked at WAITING or finished; a workflow run returned). A refusal carries
 * the reason a host words with `describeFollowUpFailure`. Unexpected failures
 * (storage errors, the run itself throwing) reject.
 */
export type ResumeRunResult =
  'started' | { readonly failed: FollowUpFailureReason };

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
   */
  readonly extraFollowUps?: readonly FollowUpQueueInput[];
  /**
   * Fires after the shared stream queue is acquired and marked RESUMING, but
   * before its queued items are drained into the rebuilt session.
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

const REFUSED: ResumeRunResult = { failed: 'not_resumable' };

export async function resumeRun(
  executionId: ExecutionId,
  options: ResumeRunOptions,
): Promise<ResumeRunResult> {
  const session = options.session ?? defaultSession();
  const isCancellationRequested = (): boolean =>
    options.isCancellationRequested?.() === true;

  const store = getExecutionStore(executionId);
  const [config, meta] = await Promise.all([
    store.readConfig(),
    store.readMeta(),
  ]);
  // FK-first: the stream id stamped at registration is the reproduction
  // contract. A row without one has no persisted stream to continue.
  const streamId = meta?.streamId;
  if (!config || !streamId) return REFUSED;
  // A stream that is already running or resuming in this process is refused,
  // not queued on the lane: a workflow run holds no follow-up queue consumer
  // and a queued resume would otherwise rerun it after it finishes.
  if (
    isCancellationRequested() ||
    session.executions.isActiveOrResuming(streamId)
  ) {
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
    return 'started';
  }
  // The persisted config and checkpoint disagree on the category.
  if (queueLease) session.followUps.release(queueLease, 'recoverable');
  return REFUSED;
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
    // `drainedFollowUps` handoff, not `appendFollowUp`: a subagent's WAITING
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
  return cancelledAtFlowAttachment || followUpsRestored ? REFUSED : 'started';
}

function toFollowUpBatchItem(item: FollowUpQueueInput): FollowUpQueueBatchItem {
  return {
    text: item.text,
    displayText: item.displayText,
    mediaFiles: item.mediaFiles,
    origin: item.origin ?? 'user',
  };
}
