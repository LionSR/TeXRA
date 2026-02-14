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
import {
  getHandle,
  AgentExecutionHandle,
} from '@agent/runtime/executionRegistry';
import { AgentLogger } from '@logger/AgentLogger';
import { ToolUseFollowUpQueue } from './ToolUseFollowUpQueueManager';
import type { StreamTabId, ExecutionId } from '@shared/schemas';

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

// ============================================================================
// Subagent follow-up (execution ID → child stream routing)
// ============================================================================

/**
 * Result of sending a follow-up to a subagent by execution ID.
 */
export type SendSubagentFollowUpResult =
  | { status: 'sent'; streamId: StreamTabId }
  | { status: 'queued'; reason: 'resuming' | 'waiting'; streamId: StreamTabId }
  | { status: 'error'; message: string }
  | {
      status: 'not_found';
      reason: 'no_handle' | 'not_agent' | 'not_tool_use';
    };

/**
 * Send a follow-up message to a subagent identified by execution ID.
 *
 * Resolves the execution ID to its child stream ID via the execution registry,
 * then delegates to the standard sendFollowUp routing. This enables orchestrators
 * to send instructions to waiting tool-use subagents for iterative refinement
 * without re-launching.
 *
 * @param executionId - Execution ID of the target subagent
 * @param text - Follow-up instruction text
 * @returns Result with routing outcome and resolved stream ID
 */
export async function sendSubagentFollowUp(
  executionId: ExecutionId,
  text: string,
): Promise<SendSubagentFollowUpResult> {
  const handle = getHandle(executionId);
  if (!handle) {
    return { status: 'not_found', reason: 'no_handle' };
  }

  if (!(handle instanceof AgentExecutionHandle)) {
    return { status: 'not_found', reason: 'not_agent' };
  }

  if (handle.category !== 'toolUse') {
    return { status: 'not_found', reason: 'not_tool_use' };
  }

  const childStreamId = handle.childStreamId;
  const result = await sendFollowUp(childStreamId, text);

  switch (result.status) {
    case 'sent':
      return { status: 'sent', streamId: childStreamId };
    case 'queued':
      return { status: 'queued', reason: result.reason, streamId: childStreamId };
    case 'error':
      return { status: 'error', message: result.message };
    case 'no_session':
      return {
        status: 'error',
        message: `Subagent stream has no active session (status: ${result.streamStatus ?? 'unknown'})`,
      };
  }
}
