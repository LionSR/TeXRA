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

// Local imports
import { getToolUseFlowContext } from '@agent/toolUse/ToolUseAgentRegistry';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { STREAM_STATUS } from '@common/constants/streamStatus';
import { AgentLogger } from '@logger/AgentLogger';

// Local file imports
import { ToolUseFollowUpQueue } from './ToolUseFollowUpQueueManager';

// ============================================================================
// Result Types
// ============================================================================

/**
 * Result of sending a follow-up message to a tool-use session.
 *
 * Pure result type - callers handle UI notifications based on status.
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
  logger.debug(`sendFollowUp called for stream: ${streamId}`);

  // Try active flow context first
  const flowContext = getToolUseFlowContext(streamId);
  if (flowContext) {
    logger.debug(`Found active flow context for stream: ${streamId}`);
    try {
      flowContext.session.appendFollowUp(text);
      logger.debug(`Follow-up appended successfully to stream: ${streamId}`);
      return { status: 'sent' };
    } catch (error) {
      logger.error('Failed to send follow-up to active session.', {
        data: error,
      });
      return { status: 'error', message: (error as Error).message };
    }
  }

  logger.debug(`No active flow context found for stream: ${streamId}`);

  // Queue if session is resuming
  if (ToolUseFollowUpQueue.isResuming(streamId)) {
    if (ToolUseFollowUpQueue.enqueue(streamId, text)) {
      logger.debug(`Queued follow-up while stream ${streamId} is resuming.`);
      return { status: 'queued', reason: 'resuming' };
    }
  }

  // Queue if session is waiting (paused, can be resumed)
  const status = StreamStatusService.get(streamId);
  logger.debug(
    `StreamStatusService status for ${streamId}: ${status ?? 'undefined'}`,
  );
  if (status === STREAM_STATUS.WAITING) {
    // Ensure queue exists and enqueue
    ToolUseFollowUpQueue.acquire(streamId);
    if (ToolUseFollowUpQueue.enqueue(streamId, text)) {
      logger.debug(
        `Queued follow-up for waiting stream ${streamId}. Resume to process.`,
      );
      return { status: 'queued', reason: 'waiting' };
    }
  }

  // No active/waiting session found - caller should handle UI notification
  logger.warn(
    `No active/waiting session found for follow-up on stream ${streamId}. Status: ${status ?? 'undefined'}`,
  );
  return { status: 'no_session', streamStatus: status };
}
