// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { shouldProbePersistedFlowForFollowUp } from '@agent/runtime/followUpResumeDetection';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import {
  sendFollowUp,
  type SendFollowUpResult,
} from '@agent/toolUse/ToolUseFollowUp';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import { retrieveSessionResumeData } from '@agent/runtime/SessionResumeRetrieval';
import { hasPersistedFlowRecord } from '@agent/storage/detectWaitingStreams';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { AgentLogger } from '@logger/AgentLogger';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { STREAM_STATUS } from '@shared/schemas';
import type { StreamTabId } from '@shared/schemas';
import { ResumeAgentResultSchema } from './resumeCommand';

const logger = new AgentLogger('followUpCommand');

const inFlightDetections = new Set<StreamTabId>();

async function lazyDetectWaitingStatus(
  streamId: StreamTabId,
): Promise<boolean> {
  const currentStatus = StreamStatusService.get(streamId);
  if (currentStatus === STREAM_STATUS.WAITING) {
    return true;
  }
  if (!shouldProbePersistedFlowForFollowUp(currentStatus)) {
    return false;
  }
  if (inFlightDetections.has(streamId)) {
    return false;
  }

  const executionId =
    ProgressViewProvider.getInstance()?.state?.meta.getExecutionId(streamId);
  if (!executionId) {
    return false;
  }

  inFlightDetections.add(streamId);
  try {
    const hasFlow = await hasPersistedFlowRecord(executionId);
    if (hasFlow) {
      StreamStatusService.set(streamId, STREAM_STATUS.WAITING, {
        runtimeHost: extensionAgentRuntimeHost,
      });
      logger.debug(`Lazy detected waiting session for stream: ${streamId}`);
    }
    return hasFlow;
  } finally {
    inFlightDetections.delete(streamId);
  }
}

async function tryAutoResume(streamId: StreamTabId): Promise<boolean> {
  if (StreamStatusService.isActiveOrResuming(streamId)) {
    logger.debug(`Stream ${streamId} is active/resuming, skipping auto-resume`);
    return false;
  }

  const progressState = ProgressViewProvider.getInstance()?.state;
  const executionId = progressState?.meta.getExecutionId(streamId);
  const taskState = progressState?.meta.getTaskState(streamId);

  if (!progressState) {
    logger.warn(`No ProgressViewProvider found for stream: ${streamId}`);
    return false;
  }
  if (!executionId) {
    logger.warn(`No execution ID found for stream: ${streamId}`);
    return false;
  }
  if (!taskState) {
    logger.warn(`No task state found for stream: ${streamId}`);
    return false;
  }

  const resumeData = await retrieveSessionResumeData(
    streamId,
    executionId,
    taskState,
  );
  if (!resumeData) {
    return false;
  }

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

async function handleFollowUpResult(
  result: SendFollowUpResult,
  streamId: StreamTabId,
): Promise<void> {
  switch (result.status) {
    case 'sent':
      extensionAgentRuntimeHost.emit('updateQueuedFollowUps', { streamId });
      break;
    case 'queued':
      extensionAgentRuntimeHost.emit('updateQueuedFollowUps', { streamId });
      if (result.reason === 'waiting' || result.reason === 'children_running') {
        const resumed = await tryAutoResume(streamId);
        // tryAutoResume also returns false when the stream is already
        // active/resuming — another consumer is on the way, so neither
        // branch below should drop the queue or warn the user.
        if (!resumed && !StreamStatusService.isActiveOrResuming(streamId)) {
          if (result.reason === 'children_running') {
            // sendFollowUp force-reopened a released queue on behalf of the
            // auto-resume attempt. Re-release drops the just-enqueued message
            // too, but that's the lesser evil — leaving the queue open would
            // leak late child deliveries into the next run on this stream.
            ToolUseFollowUpQueue.release(streamId);
            extensionAgentRuntimeHost.emit('updateQueuedFollowUps', {
              streamId,
            });
            await vscode.window.showWarningMessage(
              'Message dropped — no session available to receive it. Start a new agent task to continue.',
            );
          } else {
            await vscode.window.showInformationMessage(
              'Message queued. Auto-resume failed — start a new agent task to continue.',
            );
          }
        }
      }
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

        await lazyDetectWaitingStatus(streamId);

        const result = await sendFollowUp(streamId, text);
        await handleFollowUpResult(result, streamId);
      },
    ),
  );
}
