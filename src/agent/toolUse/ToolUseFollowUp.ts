/**
 * Tool-use follow-up message coordination.
 *
 * Routes follow-up messages to the appropriate session based on state:
 * - Active session: direct append
 * - Resuming session: queue for later
 * - No session: show warning (user can resume via UI)
 *
 * @see FollowUpQueue - the queue data structure
 * @see ToolUseFollowUpQueueManager - queue manager indexed by stream ID
 */

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { getToolUseFlowContext } from '@agent/toolUse/ToolUseAgentRegistry';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { AgentLogger } from '@logger/AgentLogger';

// Local file imports
import { ToolUseFollowUpQueue } from './ToolUseFollowUpQueueManager';

// Re-export for backwards compatibility
export { FollowUpQueue } from './FollowUpQueue';
export { ToolUseFollowUpQueue } from './ToolUseFollowUpQueueManager';

const logger = new AgentLogger('ToolUseFollowUp');

/**
 * Send a follow-up message to a tool-use session.
 *
 * Routes the message based on session state:
 * 1. Active agent: direct append
 * 2. Resuming session: queue for later
 * 3. No session: show warning (user can resume via UI command)
 *
 * Note: Lazy resume from persisted flow is handled via UI resume command,
 * not automatically on follow-up. PersistedFlow handles state persistence.
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

  // No active session found - user can resume via UI command
  logger.debug(`No active session found for follow-up on stream ${streamId}.`);
  void vscode.window.showWarningMessage(
    'No active tool-use session found. Use the Resume button to continue.',
  );
}
