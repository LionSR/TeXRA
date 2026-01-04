// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';
import {
  sendFollowUp,
  type SendFollowUpResult,
} from '@agent/toolUse/ToolUseFollowUp';
import { retrieveSessionResumeData } from '@agent/toolUse/SessionResumeRetrieval';
import {
  showErrorMessage,
  showWarningMessage,
  showInfoMessage,
} from '@frontend/ui/messageUtils';
import { AgentLogger } from '@logger/AgentLogger';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';

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
  // Use ProgressViewState for task state and execution ID access.
  // This handles legacy storage structure (workflow/toolUse buckets) and
  // provides already-validated task states, avoiding parallel access patterns.
  const progressState = ProgressViewProvider.getInstance()?.state;
  if (!progressState) {
    logger.warn(`ProgressViewProvider not available for stream: ${streamId}`);
    return false;
  }

  const executionId = progressState.getExecutionId(streamId);
  if (!executionId) {
    logger.warn(`No execution ID found for stream: ${streamId}`);
    return false;
  }

  const taskState = progressState.getTaskState(streamId);
  if (!taskState) {
    logger.warn(`No task state found for stream: ${streamId}`);
    return false;
  }

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
