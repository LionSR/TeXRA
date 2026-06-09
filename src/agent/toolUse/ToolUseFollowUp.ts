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

import {
  executionRegistry,
  type ToolUseFollowUpQueueReason,
} from '@agent/runtime/executionRegistry';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { createChannelTrace } from '@logger';
import type { StreamTabId } from '@shared/schemas';
import { ToolUseFollowUpQueue } from './ToolUseFollowUpQueueManager';

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
export async function sendFollowUp(
  streamId: StreamTabId,
  text: string,
  mediaFiles?: readonly string[],
  displayText?: string,
): Promise<SendFollowUpResult> {
  const target = executionRegistry.getToolUseFollowUpTarget(streamId);
  const followUp = { text, mediaFiles, displayText };

  if (target.kind === 'active') {
    target.context.session.appendFollowUp(followUp);
    notifyFollowUpSent(streamId, target.context.runtimeHost);
    return { status: 'sent' };
  }

  if (target.kind === 'queue') {
    // children_running reopens a queue sealed by session disposal; callers
    // must auto-resume the parent or release again to avoid stale delivery.
    const force = target.reason === 'children_running';
    ToolUseFollowUpQueue.enqueue(
      streamId,
      followUp,
      force ? { force: true } : undefined,
    );
    return { status: 'queued', reason: target.reason };
  }

  // No active/waiting session found - caller should handle UI notification
  logger.warn(
    `No active session for follow-up on stream ${streamId}. Status: ${target.streamStatus}`,
  );
  return { status: 'no_session', streamStatus: target.streamStatus };
}
