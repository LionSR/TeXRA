// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';
import {
  sendFollowUp,
  type SendFollowUpResult,
} from '@agent/toolUse/ToolUseFollowUp';
import { retrieveSessionResumeData } from '@agent/toolUse/SessionResumeRetrieval';
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

  // Validate task state structure
  // Note: TaskStateSchema is loose (passthrough on agentConfig), so we cast
  // the validated result to TaskState which has the full AgentConfig type
  const parseResult = TaskStateSchema.safeParse(rawTaskState);
  if (!parseResult.success) {
    logger.warn(`Invalid task state for stream: ${streamId}`);
    return false;
  }
  const taskState = parseResult.data as TaskState;

  // Retrieve resume data for the session type
  const resumeData = await retrieveSessionResumeData(
    streamId,
    executionId,
    taskState,
  );

  if (!resumeData) {
    // retrieveSessionResumeData logs specific failure reason
    return false;
  }

  // Trigger resume based on session type
  logger.info(`Auto-resuming ${resumeData.type} session for stream: ${streamId}`);
  try {
    if (resumeData.type === 'toolUse') {
      // Tool-use: pass snapshot to resumeAgent command
      const result = await vscode.commands.executeCommand('texra.resumeAgent', {
        snapshot: resumeData.snapshot,
      });
      return (result as { success?: boolean })?.success === true;
    } else {
      // Workflow: pass config and executionId to execute command
      await vscode.commands.executeCommand('texra.execute', {
        config: resumeData.agentConfig,
        executionId: resumeData.executionId,
      });
      return true;
    }
  } catch (error) {
    logger.error(`Failed to execute resume command for stream: ${streamId}`, {
      data: error,
    });
    return false;
  }
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
