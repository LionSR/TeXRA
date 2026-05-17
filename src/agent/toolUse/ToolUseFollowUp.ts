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

import { getActiveChildren } from '@agent/runtime/executionRegistry';
import { getToolUseFlowContext } from '@agent/toolUse/ToolUseAgentRegistry';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { AgentLogger } from '@logger/AgentLogger';
import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';
import { ToolUseFollowUpQueue } from './ToolUseFollowUpQueueManager';

/**
 * Result of sending a follow-up message to a tool-use session.
 */
export type SendFollowUpResult =
  | { status: 'sent' }
  | {
      status: 'queued';
      reason: 'resuming' | 'waiting' | 'children_running';
    }
  | { status: 'no_session'; streamStatus: string | undefined };

const logger = new AgentLogger('ToolUseFollowUp');
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
): Promise<SendFollowUpResult> {
  // Try active flow context first
  const flowContext = getToolUseFlowContext(streamId);
  if (flowContext) {
    flowContext.session.appendFollowUp(text);
    notifyFollowUpSent(streamId, flowContext.runtimeHost);
    return { status: 'sent' };
  }

  // Queue if session is resuming
  if (ToolUseFollowUpQueue.isResuming(streamId)) {
    ToolUseFollowUpQueue.enqueue(streamId, text);
    return { status: 'queued', reason: 'resuming' };
  }

  // Queue if session is waiting (paused, can be resumed)
  const status = StreamStatusService.get(streamId);
  if (status === STREAM_STATUS.WAITING) {
    ToolUseFollowUpQueue.enqueue(streamId, text);
    return { status: 'queued', reason: 'waiting' };
  }

  const { subagents, processes } = getActiveChildren(streamId);
  if (subagents.length > 0 || processes.length > 0) {
    // force:true reopens a queue sealed by sessionLifecycle disposal — the
    // caller must auto-resume the parent or re-release, or late child
    // deliveries will leak into the next run on this stream.
    ToolUseFollowUpQueue.enqueue(streamId, text, { force: true });
    return { status: 'queued', reason: 'children_running' };
  }

  // No active/waiting session found - caller should handle UI notification
  logger.warn(
    `No active session for follow-up on stream ${streamId}. Status: ${status ?? 'undefined'}`,
  );
  return { status: 'no_session', streamStatus: status };
}
