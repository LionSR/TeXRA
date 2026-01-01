/**
 * Tool-use follow-up message coordination.
 *
 * Routes follow-up messages to the appropriate session based on state:
 * - Active session: direct append
 * - Resuming session: queue for later
 * - No session: show warning (user can resume via UI)
 */

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { getToolUseFlowContext } from '@agent/toolUse/ToolUseAgentRegistry';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { STREAM_STATUS } from '@common/constants/streamStatus';
import { AgentLogger } from '@logger/AgentLogger';

// Local file imports
import { ToolUseFollowUpQueue } from './ToolUseFollowUpQueueManager';

const logger = new AgentLogger('ToolUseFollowUp');

/**
 * Send a follow-up message to a tool-use session.
 *
 * Routes the message based on session state:
 * 1. Active agent: direct append
 * 2. Resuming/Waiting session: queue for later
 * 3. No session: show warning (user can resume via UI command)
 *
 * Note: Messages queued for WAITING sessions are picked up when user resumes.
 * PersistedFlow handles state persistence.
 */
export async function sendFollowUp(
  streamId: StreamTabId,
  text: string,
): Promise<void> {
  // Try active flow context first
  const flowContext = getToolUseFlowContext(streamId);
  if (flowContext) {
    try {
      flowContext.session.appendFollowUp(text);
    } catch (error) {
      logger.error('Failed to send follow-up to active session.', {
        data: error,
      });
      await vscode.window.showErrorMessage(
        `Failed to send follow-up: ${(error as Error).message}`,
      );
    }
    return;
  }

  // Queue if session is resuming
  if (ToolUseFollowUpQueue.isResuming(streamId)) {
    if (ToolUseFollowUpQueue.enqueue(streamId, text)) {
      logger.debug(`Queued follow-up while stream ${streamId} is resuming.`);
      return;
    }
  }

  // Queue if session is waiting (paused, can be resumed)
  const status = StreamStatusService.get(streamId);
  if (status === STREAM_STATUS.WAITING) {
    // Ensure queue exists and enqueue
    ToolUseFollowUpQueue.acquire(streamId);
    if (ToolUseFollowUpQueue.enqueue(streamId, text)) {
      logger.debug(
        `Queued follow-up for waiting stream ${streamId}. Resume to process.`,
      );
      return;
    }
  }

  // No active/waiting session found - user can resume via UI command
  logger.debug(`No active session found for follow-up on stream ${streamId}.`);
  void vscode.window.showWarningMessage(
    'No active tool-use session found. Use the Resume button to continue.',
  );
}
