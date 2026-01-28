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

import { STREAM_STATUS } from '@shared/schemas';
import { getToolUseFlowContext } from '@agent/toolUse/ToolUseAgentRegistry';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { AgentLogger } from '@logger/AgentLogger';
import { ToolUseFollowUpQueue } from './ToolUseFollowUpQueueManager';
import type { StreamTabId } from '@shared/schemas';

/**
 * Result of sending a follow-up message to a tool-use session.
 */
export type SendFollowUpResult =
  | { status: 'sent' }
  | { status: 'queued'; reason: 'resuming' | 'waiting' }
  | { status: 'error'; message: string }
  | { status: 'no_session'; streamStatus: string | undefined };

const logger = new AgentLogger('ToolUseFollowUp');

/**
 * Send a follow-up message to a tool-use session.
 *
 * Routes the message based on session state:
 * 1. Active agent: direct append → returns { status: 'sent' }
 * 2. Resuming/Waiting session: queue for later → returns { status: 'queued' }
 * 3. Error during send → returns { status: 'error' }
 * 4. No session found → returns { status: 'no_session' }
 *
 * Note: Messages queued for WAITING sessions are picked up when user resumes.
 * PersistedFlow handles state persistence.
 *
 * @returns Result indicating what happened - callers handle UI notifications
 */
export async function sendFollowUp(
  streamId: StreamTabId,
  text: string,
): Promise<SendFollowUpResult> {
  // Try active flow context first
  const flowContext = getToolUseFlowContext(streamId);
  if (flowContext) {
    try {
      flowContext.session.appendFollowUp(text);
      return { status: 'sent' };
    } catch (error) {
      logger.error('Failed to send follow-up to active session.', {
        data: error,
      });
      return { status: 'error', message: (error as Error).message };
    }
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

  // No active/waiting session found - caller should handle UI notification
  logger.warn(
    `No active session for follow-up on stream ${streamId}. Status: ${status ?? 'undefined'}`,
  );
  return { status: 'no_session', streamStatus: status };
}
