import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import type { FollowUpQueueInput } from '@agent/followUp/FollowUpQueue';
import type { AgentRuntimeFlowResult } from '@agent/runtime/AgentFlowResult';
import {
  STREAM_PHASE,
  STREAM_SUBSTATE,
  type StreamTabId,
} from '@shared/schemas';
import {
  resumeToolUseFromSnapshot,
  type SubagentRunOptions,
} from './executeAgent';
import { defaultSession } from './SessionHandle';

import type { AgentRuntimeHost } from './AgentRuntimeHost';

export interface ResumeQueuedToolUseOptions extends SubagentRunOptions {
  /** Query a caller-owned stop request at the resumed flow attachment boundary. */
  readonly isCancellationRequested?: () => boolean;
  /**
   * Fires with the resumed run's raw outcome — terminal or WAITING — right
   * after the call returns successfully. Additive to `onRunError`, which only
   * covers the terminal branch; native child-run strategies use this to
   * recover the WAITING result value that would otherwise be discarded by
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
   * Host-specific failure surface (log + toast). Invoked after the stream has
   * been returned to WAITING, so a blocking host dialog cannot strand the
   * stream in RESUMING while it awaits dismissal.
   */
  readonly onError: (error: unknown) => void | Promise<void>;
}

/**
 * Drive the shared tool-use resume "queue dance" that both the VS Code
 * extension and the desktop bridge wrap around `resumeToolUseFromSnapshot`:
 *
 *   acquire the follow-up queue → flip the stream to RESUMING → drain the
 *   queued follow-ups and notify the UI → resume, re-appending the drained
 *   items into the rebuilt session → on failure, re-enqueue the follow-ups
 *   (force) and re-notify → always return the stream to WAITING if the resume
 *   never reached the run lifecycle.
 *
 * Hosts stay thin adapters: they supply only what differs (`session`,
 * `runtimeUnavailableTools`, an optional seed follow-up, and the `onError`
 * toast). Returns `true` when the resume completed and `false` when it failed
 * or was cancelled before the rebuilt session accepted its follow-ups.
 */
export async function resumeQueuedToolUseSnapshot(
  streamId: StreamTabId,
  snapshot: ToolUseSessionSnapshot,
  runtimeHost: AgentRuntimeHost,
  options: ResumeQueuedToolUseOptions,
): Promise<boolean> {
  const session = options.session ?? defaultSession();
  const streamStatus = session.status;
  const followUpsQueue = session.followUps;

  followUpsQueue.acquire(streamId);
  streamStatus.transition(streamId, STREAM_PHASE.RUNNING, 'resume', {
    events: session.events,
    substate: STREAM_SUBSTATE.RESUMING,
  });

  const seed = options.extraFollowUps ?? [];
  let followUps: readonly FollowUpQueueInput[] = seed;
  let cancelledBeforeSessionSetup = false;
  let resumeError: { error: unknown } | undefined;
  const restoreFollowUps = (): void => {
    for (const item of followUps) {
      followUpsQueue.enqueue(streamId, item, { force: true });
    }
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
    followUps = [...seed, ...followUpsQueue.drainItems(streamId)];
    session.events.emit({
      scope: 'session',
      event: {
        type: 'updateQueuedFollowUps',
        payload: { streamId },
      },
    });

    const result = await resumeToolUseFromSnapshot(snapshot, runtimeHost, {
      session: options.session,
      approvalPromptsUnavailable: options.approvalPromptsUnavailable,
      runtimeUnavailableTools: options.runtimeUnavailableTools,
      parentStreamId:
        options.parentStreamId ?? snapshot.parentStreamId ?? undefined,
      allowWaitingResult: options.allowWaitingResult,
      onFollowUpConsumed: options.onFollowUpConsumed,
      onProgress: options.onProgress,
      onRunError: options.onRunError,
      onRun: options.onRun,
      isCancellationRequested: options.isCancellationRequested,
      setupSession: (session) => {
        if (options.isCancellationRequested?.()) {
          cancelledBeforeSessionSetup = true;
          // Capture messages accepted after the initial drain before the
          // cancellation handoff disposes the shared stream queue.
          followUps = [...followUps, ...followUpsQueue.drainItems(streamId)];
          return;
        }
        for (const item of followUps) {
          session.appendFollowUp(item);
        }
      },
    });
    options.onResult?.(result);
    if (cancelledBeforeSessionSetup) restoreFollowUps();
  } catch (error) {
    resumeError = { error };
    // Re-enqueue the drained follow-ups (explicit seed first) so a later
    // resume replays them instead of dropping them.
    restoreFollowUps();
  } finally {
    // Early failures leave the stream RESUMING. Startup cancellation can
    // instead reach lifecycle terminalization before the queue owner regains
    // control. In both cases, restored input makes WAITING the durable state.
    if (
      cancelledBeforeSessionSetup ||
      streamStatus.getSubstate(streamId) === STREAM_SUBSTATE.RESUMING
    ) {
      streamStatus.transitionToWaiting(streamId, 'wait', {
        events: session.events,
      });
    }
  }

  if (!resumeError) {
    return !cancelledBeforeSessionSetup;
  }
  try {
    await options.onError(resumeError.error);
  } catch {
    // A broken host error surface should not turn a handled resume failure into
    // an unhandled rejection.
  }
  return false;
}
