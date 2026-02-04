// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { STREAM_STATUS } from '@shared/schemas';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import {
  sendFollowUp,
  type SendFollowUpResult,
} from '@agent/toolUse/ToolUseFollowUp';
import { retrieveSessionResumeData } from '@agent/runtime/SessionResumeRetrieval';
import { hasPersistedFlowRecord } from '@agent/storage/detectWaitingStreams';
import { AgentLogger } from '@logger/AgentLogger';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { bus } from '@eventBus/ProgressEventBus';
import { ResumeAgentResultSchema } from './resumeCommand';
import type { StreamTabId } from '@shared/schemas';

const logger = new AgentLogger('followUpCommand');

// Track in-flight lazy detection checks to prevent race conditions
const inFlightDetections = new Set<StreamTabId>();

/**
 * Lazily detect if a stream has a persisted flow record and set WAITING status.
 *
 * Enables lazy loading - we only check for persisted flows when user sends a follow-up,
 * avoiding startup iteration through all streams.
 *
 * @returns true if a persisted flow was detected and status was set to WAITING
 */
async function lazyDetectWaitingStatus(
  streamId: StreamTabId,
): Promise<boolean> {
  // Skip if status already set or detection in progress
  const currentStatus = StreamStatusService.get(streamId);
  if (currentStatus) {
    return currentStatus === STREAM_STATUS.WAITING;
  }
  if (inFlightDetections.has(streamId)) {
    return false;
  }

  // Get execution ID to check for persisted flow
  const executionId =
    ProgressViewProvider.getInstance()?.state?.getExecutionId(streamId);
  if (!executionId) {
    return false;
  }

  // Check for persisted flow (with in-flight guard)
  inFlightDetections.add(streamId);
  try {
    const hasFlow = await hasPersistedFlowRecord(executionId);
    if (hasFlow) {
      StreamStatusService.set(streamId, STREAM_STATUS.WAITING);
      logger.debug(`Lazy detected waiting session for stream: ${streamId}`);
    }
    return hasFlow;
  } finally {
    inFlightDetections.delete(streamId);
  }
}

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
  // Guard against concurrent resume attempts
  if (StreamStatusService.isActiveOrResuming(streamId)) {
    logger.debug(`Stream ${streamId} is active/resuming, skipping auto-resume`);
    return false;
  }

  // Get state dependencies - ProgressViewState handles legacy storage structure
  const progressState = ProgressViewProvider.getInstance()?.state;
  const executionId = progressState?.getExecutionId(streamId);
  const taskState = progressState?.getTaskState(streamId);

  if (!progressState || !executionId || !taskState) {
    let missing: string;
    if (!progressState) {
      missing = 'ProgressViewProvider';
    } else if (!executionId) {
      missing = 'execution ID';
    } else {
      missing = 'task state';
    }
    logger.warn(`No ${missing} found for stream: ${streamId}`);
    return false;
  }

  // Retrieve resume data for the session type
  const resumeData = await retrieveSessionResumeData(
    streamId,
    executionId,
    taskState,
  );
  if (!resumeData) {
    return false;
  }

  // Trigger resume based on session type
  logger.info(
    `Auto-resuming ${resumeData.type} session for stream: ${streamId}`,
  );
  try {
    if (resumeData.type === 'toolUse') {
      const rawResult = await vscode.commands.executeCommand(
        'texra.resumeAgent',
        { snapshot: resumeData.snapshot },
      );
      const parseResult = ResumeAgentResultSchema.safeParse(rawResult);
      return parseResult.success && parseResult.data.success;
    }
    // Workflow: execute returns void - success if no exception thrown
    await vscode.commands.executeCommand('texra.execute', {
      config: resumeData.agentConfig,
      executionId: resumeData.executionId,
    });
    return true;
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
      // Also update queue display (message was sent, queue may be empty now)
      bus.emit('updateQueuedFollowUps', { streamId });
      break;
    case 'queued':
      // Update the queued follow-ups display
      bus.emit('updateQueuedFollowUps', { streamId });
      if (result.reason === 'waiting') {
        // Auto-resume WAITING tool-use sessions
        const resumed = await tryAutoResume(streamId);
        if (!resumed) {
          // Fallback: show message if auto-resume fails
          await vscode.window.showInformationMessage(
            'Message queued. Click Resume to process it.',
          );
        }
      }
      // For 'resuming' reason, message is queued for the in-progress resume
      break;
    case 'error':
      await vscode.window.showErrorMessage(
        `Failed to send follow-up: ${result.message}`,
      );
      break;
    case 'no_session':
      await vscode.window.showWarningMessage(
        'No active session. Start a new agent task to continue.',
      );
      break;
  }
}

export function registerFollowUpCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texra.sendFollowUp',
      async (payload: { stream: StreamTabId; text: string }) => {
        const { stream: streamId, text } = payload;

        // Lazy detection: check for persisted flow if status not already set.
        // This avoids iterating through all streams at startup.
        await lazyDetectWaitingStatus(streamId);

        const result = await sendFollowUp(streamId, text);
        await handleFollowUpResult(result, streamId);
      },
    ),
  );
}
