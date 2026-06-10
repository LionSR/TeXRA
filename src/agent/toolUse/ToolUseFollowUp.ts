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
import {
  executionRegistry,
  type ToolUseFollowUpQueueReason,
} from '@agent/runtime/executionRegistry';
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
  const resumed = await platform().agentResume.tryResumeStream(streamId);
  if (
    resumed ||
    result.reason !== 'children_running' ||
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
  runtimeHost?.emit('followUpSent', { streamId });
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
 */
export function sendFollowUp(
  streamId: StreamTabId,
  followUp: FollowUpQueueInput,
): Promise<SendFollowUpResult>;
export function sendFollowUp(
  streamId: StreamTabId,
  followUp: string,
  mediaFiles?: readonly string[],
  displayText?: string,
): Promise<SendFollowUpResult>;
export async function sendFollowUp(
  streamId: StreamTabId,
  followUp: string | FollowUpQueueInput,
  mediaFiles?: readonly string[],
  displayText?: string,
): Promise<SendFollowUpResult> {
  const target = executionRegistry.getToolUseFollowUpTarget(streamId);
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
