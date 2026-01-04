// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';
import {
  sendFollowUp,
  type SendFollowUpResult,
} from '@agent/toolUse/ToolUseFollowUp';
import { retrieveToolUseSnapshot } from '@agent/toolUse/ToolUseSnapshotRetrieval';
import { workspaceSM, WorkspaceStateKey } from '@common/state/stateManager';
import {
  showErrorMessage,
  showWarningMessage,
  showInfoMessage,
} from '@frontend/ui/messageUtils';
import { TaskStateSchema, type TaskState } from '@logger/TaskState';
import { AgentLogger } from '@logger/AgentLogger';

const logger = new AgentLogger('followUpCommand');

/**
 * Attempt to auto-resume a WAITING tool-use session.
 *
 * When a follow-up is queued for a WAITING session, this function retrieves
 * the session snapshot and triggers resume. The queued follow-up will be
 * automatically processed during resume (no need to pass it separately).
 *
 * @returns true if resume was triggered, false otherwise
 */
async function tryAutoResume(streamId: StreamTabId): Promise<boolean> {
  // Get execution ID from persisted state
  const executionIds =
    workspaceSM.get<Record<string, string>>(WorkspaceStateKey.EXECUTION_IDS) ??
    {};
  const executionId = executionIds[streamId] as ExecutionId | undefined;

  if (!executionId) {
    logger.warn(`No execution ID found for stream: ${streamId}`);
    return false;
  }

  // Get task state from persisted state
  const taskStates =
    workspaceSM.get<Record<string, unknown>>(WorkspaceStateKey.TASK_STATES) ??
    {};
  const rawTaskState = taskStates[streamId];

  if (!rawTaskState) {
    logger.warn(`No task state found for stream: ${streamId}`);
    return false;
  }

  // Validate task state
  const parseResult = TaskStateSchema.safeParse(rawTaskState);
  if (!parseResult.success) {
    logger.warn(`Invalid task state for stream: ${streamId}`);
    return false;
  }

  const taskState = rawTaskState as TaskState;

  // Retrieve the snapshot
  const snapshot = await retrieveToolUseSnapshot(
    streamId,
    executionId,
    taskState,
  );

  if (!snapshot) {
    logger.warn(`Failed to retrieve snapshot for stream: ${streamId}`);
    return false;
  }

  // Trigger resume (follow-up is already queued, don't pass it again)
  logger.info(`Auto-resuming tool-use session for stream: ${streamId}`);
  const result = await vscode.commands.executeCommand('texra.resumeAgent', {
    snapshot,
    // No followUp parameter - it's already in the queue
  });

  return (result as { success?: boolean })?.success === true;
}

/**
 * Handle follow-up result and show appropriate UI notifications.
 *
 * This is the VS Code integration layer - it converts pure result types
 * to VS Code notifications.
 */
async function handleFollowUpResult(
  result: SendFollowUpResult,
  streamId: StreamTabId,
): Promise<void> {
  switch (result.status) {
    case 'sent':
      // Silent success - no notification needed
      break;
    case 'queued':
      if (result.reason === 'waiting') {
        // Auto-resume WAITING tool-use sessions
        const resumed = await tryAutoResume(streamId);
        if (!resumed) {
          // Fallback: show message if auto-resume fails
          await showInfoMessage(
            'Message queued. Click Resume to process it.',
          );
        }
      }
      // For 'resuming' reason, message is queued for the in-progress resume
      break;
    case 'error':
      await showErrorMessage(`Failed to send follow-up: ${result.message}`);
      break;
    case 'no_session':
      await showWarningMessage(
        'No active tool-use session found. Use the Resume button to continue.',
      );
      break;
  }
}

export function registerFollowUpCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texra.sendFollowUp',
      async (payload: { stream: string; text: string }) => {
        const streamId = payload.stream as StreamTabId;
        const result = await sendFollowUp(streamId, payload.text);
        await handleFollowUpResult(result, streamId);
      },
    ),
  );
}
