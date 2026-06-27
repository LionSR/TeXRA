/**
 * Tool-use follow-up message coordination.
 *
 * Routes follow-up messages to the appropriate session based on state:
 * - Active session: direct append
 * - Resuming session: queue for later
 * - No session: return status (caller handles UI)
 *
 * This module is VS Code-agnostic. Callers are responsible for
 * showing appropriate UI notifications based on the returned result.
 */

import { platform } from '@platform';
import { type ToolUseFollowUpQueueReason } from '@agent/runtime/executionRegistry';
import { getQueuedFollowUpsProjection } from '@agent/runtime/queuedFollowUps';
import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { createChannelTrace } from '@logger';
import type { StreamTabId } from '@shared/schemas';
import { ToolUseFollowUpQueue } from './ToolUseFollowUpQueueManager';
import type { FollowUpQueueInput } from './FollowUpQueue';

/**
 * Result of sending a follow-up message to a tool-use session.
 */
export type SendFollowUpResult =
  | { status: 'sent' }
  | {
      status: 'queued';
      reason: ToolUseFollowUpQueueReason;
    }
  | { status: 'no_session'; streamStatus: string | undefined };

/** In-flight resume attempts per stream — see {@link wakeOrReleaseQueuedStream}. */
const wakeAttempts = new Map<StreamTabId, Promise<boolean>>();

/**
 * After a queued delivery, wake a stream whose cycle has exited (WAITING
 * snapshot or disposed-with-children) via the host resume port so the queued
 * item is consumed instead of sitting until the user pokes the stream. When
 * the wake fails and the stream is gone for good (`children_running` on a
 * non-in-flight stream), re-release the force-reopened queue so late
 * deliveries don't leak into the next run on that stream.
 *
 * Returns false when the queued item was dropped by the re-release; callers
 * should treat the delivery as failed and rely on their durable copy.
 */
export async function wakeOrReleaseQueuedStream(
  streamId: StreamTabId,
  result: SendFollowUpResult,
): Promise<boolean> {
  if (
    result.status !== 'queued' ||
    (result.reason !== 'waiting' && result.reason !== 'children_running')
  ) {
    return true;
  }
  // Serialize wakes per stream: hosts report an already-in-flight resume as
  // `false`, indistinguishable from "unresumable", and may not have set
  // RESUMING yet — so a concurrent wake must await the first attempt's
  // outcome instead of re-poking the port and releasing the queue the
  // in-flight resume is about to drain.
  let attempt = wakeAttempts.get(streamId);
  const resumePort = platform().agentResume;
  if (!attempt) {
    attempt = resumePort.tryResumeStream(streamId).finally(() => {
      wakeAttempts.delete(streamId);
    });
    wakeAttempts.set(streamId, attempt);
  }
  const resumed = await attempt;
  if (
    resumed ||
    result.reason !== 'children_running' ||
    resumePort.isResumeInFlight?.(streamId) === true ||
    StreamStatusService.isActiveOrResuming(streamId)
  ) {
    return true;
  }
  ToolUseFollowUpQueue.release(streamId);
  return false;
}

const logger = createChannelTrace('ToolUseFollowUp');
const followUpSentObservers = new Set<(streamId: StreamTabId) => void>();

export function onFollowUpSent(
  observer: (streamId: StreamTabId) => void,
): () => void {
  followUpSentObservers.add(observer);
  return () => {
    followUpSentObservers.delete(observer);
  };
}

export function notifyFollowUpSent(
  streamId: StreamTabId,
  runtimeHost?: AgentRuntimeHost,
): void {
  for (const observer of followUpSentObservers) {
    try {
      observer(streamId);
    } catch (err) {
      logger.warn(
        `Follow-up sent observer threw for stream ${streamId}: ${String(err)}`,
      );
    }
  }
  runtimeHost?.emit('followUpSent', getQueuedFollowUpsProjection(streamId));
}

/**
 * Send a follow-up message to a tool-use session.
 *
 * Routes based on session state:
 * 1. Active agent: direct append → { status: 'sent' }
 * 2. Resuming/Waiting session: queue for later → { status: 'queued' }
 * 3. No session found → { status: 'no_session' }
 *
 * Items queued for WAITING sessions are picked up when user resumes.
 *
 * `session` defaults to {@link currentSession} so in-run callers (binder send,
 * bash, delegation, CLI session loop, inquiry continuation) resolve the active
 * run's session via the ALS and stay byte-identical. HOST-PATH callers that
 * run OUTSIDE any run ALS (e.g. the desktop progress-view IPC handler, whose
 * runs are tracked in a per-window session, not the process default) MUST pass
 * their owning session, or the run's handle is looked up in the wrong registry
 * and a live follow-up is dropped as `no_session`.
 */
export function sendFollowUp(
  streamId: StreamTabId,
  followUp: FollowUpQueueInput,
): Promise<SendFollowUpResult>;
export function sendFollowUp(
  streamId: StreamTabId,
  followUp: FollowUpQueueInput,
  mediaFiles: undefined,
  displayText: undefined,
  session?: SessionHandle,
): Promise<SendFollowUpResult>;
export function sendFollowUp(
  streamId: StreamTabId,
  followUp: string,
  mediaFiles?: readonly string[],
  displayText?: string,
  session?: SessionHandle,
): Promise<SendFollowUpResult>;
export async function sendFollowUp(
  streamId: StreamTabId,
  followUp: string | FollowUpQueueInput,
  mediaFiles?: readonly string[],
  displayText?: string,
  session?: SessionHandle,
): Promise<SendFollowUpResult> {
  const target = (
    session ?? currentSession()
  ).executions.getToolUseFollowUpTarget(streamId);
  const item =
    typeof followUp === 'string'
      ? { text: followUp, mediaFiles, displayText }
      : followUp;

  if (target.kind === 'active') {
    target.context.session.appendFollowUp(item);
    notifyFollowUpSent(streamId, target.context.runtimeHost);
    return { status: 'sent' };
  }

  if (target.kind === 'queue') {
    // children_running reopens a queue sealed by session disposal; callers
    // must auto-resume the parent or release again to avoid stale delivery.
    const force = target.reason === 'children_running';
    ToolUseFollowUpQueue.enqueue(
      streamId,
      item,
      force
        ? { createIfMissing: true, force: true }
        : { createIfMissing: true },
    );
    return { status: 'queued', reason: target.reason };
  }

  // No active/waiting session found - caller should handle UI notification
  logger.warn(
    `No active session for follow-up on stream ${streamId}. Status: ${target.streamStatus}`,
  );
  return { status: 'no_session', streamStatus: target.streamStatus };
}
