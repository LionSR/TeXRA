import type {
  FollowUpQueueBatchItem,
  FollowUpQueueInput,
} from '@agent/followUp/FollowUpQueue';
import type { FollowUpRecoveryLease } from '@agent/followUp/ToolUseFollowUpQueueManager';
import {
  isWaitingFlowResult,
  type AgentRuntimeFlowResult,
} from '@agent/runtime/AgentFlowResult';
import type { RecoveryContinuation } from '@platform/interfaces';
import {
  STREAM_PHASE,
  STREAM_SUBSTATE,
  type StreamTabId,
} from '@shared/schemas';
import {
  resumeToolUseFromResumeData,
  ResumeAdmissionCancelledError,
  type SubagentRunOptions,
} from './executeAgent';
import { defaultSession } from './SessionHandle';
import type { ToolUseResumeData } from './SessionResumeRetrieval';

export interface ResumeQueuedToolUseOptions extends Pick<
  SubagentRunOptions,
  | 'session'
  | 'tools'
  | 'approvalPromptsUnavailable'
  | 'onApprovalPolicyDenial'
  | 'runtimeUnavailableTools'
> {
  /** Recovery ownership synchronously claimed by the submission boundary. */
  readonly recovery?: RecoveryContinuation;
  /** Recheck canonical admission atomically while acquiring the resumed lease. */
  readonly canAcquireResumeLease?: () => boolean | Promise<boolean>;
  /** Query a caller-owned stop request at the resumed flow attachment boundary. */
  readonly isCancellationRequested?: () => boolean;
  /**
   * Fires with the resumed run's raw outcome — terminal or WAITING — right
   * after the call returns successfully. Native child-run strategies use this
   * to recover the WAITING result value that would otherwise be discarded by
   * this function's own boolean return.
   */
  readonly onResult?: (result: AgentRuntimeFlowResult) => void;
  /**
   * Follow-ups to replay ahead of any items already queued for the stream
   * (e.g. an explicit follow-up typed alongside a manual resume). Seeded before
   * the drain so the failure path re-enqueues them even if the drain throws
   * before the full list is assigned.
   */
  readonly extraFollowUps?: readonly FollowUpQueueInput[];
  /**
   * Fires after the shared stream queue is acquired and marked RESUMING, but
   * before its queued items are drained into the rebuilt session.
   */
  readonly onFollowUpQueueReady?: (recovery: FollowUpRecoveryLease) => void;
  /**
   * Host-specific failure surface (log + toast). Invoked after the stream has
   * been returned to WAITING, so a blocking host dialog cannot strand the
   * stream in RESUMING while it awaits dismissal.
   */
  readonly onError: (error: unknown) => void | Promise<void>;
}

/**
 * Drive the shared tool-use resume "queue dance" that both the VS Code
 * extension and the desktop bridge wrap around `resumeToolUseFromResumeData`:
 *
 *   acquire the follow-up queue → flip the stream to RESUMING → drain the
 *   queued follow-ups and notify the UI → resume, handing the drained batch
 *   to the flow's WAITING cursor via `drainedFollowUps` → on failure,
 *   re-enqueue the follow-ups (force) and re-notify → always return the
 *   stream to WAITING if the resume never reached the run lifecycle.
 *
 * Hosts stay thin adapters: they supply only what differs (`session`,
 * `runtimeUnavailableTools`, an optional seed follow-up, and the `onError`
 * toast). Returns `true` when the resume completed and `false` when it failed
 * or returned before the resumed cursor consumed its follow-ups.
 */
export async function resumeQueuedToolUseFromResumeData(
  streamId: StreamTabId,
  resume: ToolUseResumeData,
  options: ResumeQueuedToolUseOptions,
): Promise<boolean> {
  const session = options.session ?? defaultSession();
  const streamStatus = session.status;
  const followUpsQueue = session.followUps;

  const existingHandle = session.executions.getHandle(resume.executionId);
  if (existingHandle?.suspendedTerminationStarted) {
    return false;
  }

  const queueLease = options.recovery
    ? followUpsQueue.useRecovery(options.recovery)
    : followUpsQueue.claimRecovery(streamId, true);
  if (!queueLease) return false;
  streamStatus.transition(streamId, STREAM_PHASE.RUNNING, 'resume', {
    substate: STREAM_SUBSTATE.RESUMING,
  });

  const seed = options.extraFollowUps ?? [];
  let followUps: readonly FollowUpQueueInput[] = seed;
  let cancelledAtFlowAttachment = false;
  let cancelledBeforeLaunch = false;
  let followUpsRestored = false;
  let resumeError: { error: unknown } | undefined;
  let runResult: AgentRuntimeFlowResult | undefined;
  const restoreFollowUps = (): void => {
    if (followUpsRestored) return;
    followUpsRestored = true;
    followUpsQueue.queue(queueLease).restore(followUps);
    if (followUps.length > 0) {
      session.events.emit({
        scope: 'session',
        event: {
          type: 'updateQueuedFollowUps',
          payload: { streamId },
        },
      });
    }
  };
  try {
    options.onFollowUpQueueReady?.(queueLease);
    followUps = [...seed, ...followUpsQueue.queue(queueLease).drainItems()];
    session.events.emit({
      scope: 'session',
      event: {
        type: 'updateQueuedFollowUps',
        payload: { streamId },
      },
    });

    // The drained batch must reach the resumed flow through the direct
    // `drainedFollowUps` handoff, not `appendFollowUp`: a subagent's WAITING
    // cursor suspends again before ever reading the stream queue (see
    // `ToolUseWaitNode` — only its child-run loop's queue wait consumes it),
    // so re-queued items would sit unconsumed until the next wake. A root
    // cursor accepts either route; the handoff works for both.
    const result = await resumeToolUseFromResumeData(resume, {
      session: options.session,
      tools: options.tools,
      approvalPromptsUnavailable: options.approvalPromptsUnavailable,
      onApprovalPolicyDenial: options.onApprovalPolicyDenial,
      runtimeUnavailableTools: options.runtimeUnavailableTools,
      parentStreamId: resume.parentStreamId,
      onFollowUpConsumed: () => {
        followUps = [];
      },
      ...(options.canAcquireResumeLease && {
        canAcquireResumeLease: options.canAcquireResumeLease,
      }),
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
    runResult = result;
    if (followUps.length > 0) restoreFollowUps();
    options.onResult?.(result);
  } catch (error) {
    cancelledBeforeLaunch = error instanceof ResumeAdmissionCancelledError;
    if (!cancelledBeforeLaunch) resumeError = { error };
    // A rejection before the wait node acknowledges consumption must replay
    // the drained batch. A callback failure after that acknowledgement must
    // not enqueue the same user input again.
    if (
      followUps.length > 0 &&
      (!cancelledBeforeLaunch || session.transcripts.has(streamId))
    ) {
      restoreFollowUps();
    }
  } finally {
    // Early failures leave the stream RESUMING. Startup cancellation can
    // instead reach lifecycle terminalization before the queue owner regains
    // control. In both cases, restored input makes WAITING the durable state.
    // Guarded admission lost to deletion only after canonical removal, whose
    // process-session cleanup owns status; do not recreate either here.
    if (
      (!cancelledBeforeLaunch || session.transcripts.has(streamId)) &&
      (cancelledAtFlowAttachment ||
        followUpsRestored ||
        streamStatus.getSubstate(streamId) === STREAM_SUBSTATE.RESUMING)
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

  if (cancelledBeforeLaunch) return false;
  if (!resumeError) {
    return !cancelledAtFlowAttachment && !followUpsRestored;
  }
  try {
    await options.onError(resumeError.error);
  } catch {
    // A broken host error surface should not turn a handled resume failure into
    // an unhandled rejection.
  }
  return false;
}

function toFollowUpBatchItem(item: FollowUpQueueInput): FollowUpQueueBatchItem {
  return {
    text: item.text,
    displayText: item.displayText,
    mediaFiles: item.mediaFiles,
    origin: item.origin ?? 'user',
  };
}
