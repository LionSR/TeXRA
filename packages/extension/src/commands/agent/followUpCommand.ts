// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { deriveResumability } from '@agent/storage';
import {
  sendFollowUp,
  wakeQueuedFollowUpStream,
  type SendFollowUpResult,
} from '@agent/followUp/ToolUseFollowUp';
import { emitRuntimeEvent } from '@agent/runtime/emitRuntimeEvent';
import { shouldProbePersistedFlowForFollowUp } from '@agent/runtime/followUpResumeDetection';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { registerCommands } from '@commands/_shared/registerCommands';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { createChannelTrace } from '@logger';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { STREAM_PHASE } from '@shared/schemas';
import type { StreamTabId } from '@shared/schemas';

const logger = createChannelTrace('followUpCommand');

const inFlightDetections = new Set<StreamTabId>();

async function lazyDetectWaitingStatus(
  streamId: StreamTabId,
): Promise<boolean> {
  const currentStatus = StreamStatusService.get(streamId);
  if (currentStatus === STREAM_PHASE.WAITING) {
    return true;
  }
  if (!shouldProbePersistedFlowForFollowUp(currentStatus)) {
    return false;
  }
  if (inFlightDetections.has(streamId)) {
    return false;
  }

  const executionId =
    ProgressViewProvider.getInstance()?.state?.snapshots.getExecutionId(
      streamId,
    );
  if (!executionId) {
    return false;
  }

  inFlightDetections.add(streamId);
  try {
    const resumability = await deriveResumability(executionId);
    if (resumability.resumable) {
      const repaired = StreamStatusService.transitionToWaiting(
        streamId,
        'restart-repair',
        {
          events: defaultSession().events,
        },
      );
      if (repaired) {
        logger.debug(`Lazy detected waiting session for stream: ${streamId}`);
      }
      return repaired;
    }
    return false;
  } finally {
    inFlightDetections.delete(streamId);
  }
}

async function handleFollowUpResult(
  result: SendFollowUpResult,
  streamId: StreamTabId,
): Promise<void> {
  switch (result.status) {
    case 'sent':
      emitRuntimeEvent('updateQueuedFollowUps', { streamId });
      break;
    case 'queued':
      emitRuntimeEvent('updateQueuedFollowUps', { streamId });
      switch ((await wakeQueuedFollowUpStream(streamId, result)).kind) {
        case 'dropped':
          emitRuntimeEvent('updateQueuedFollowUps', { streamId });
          await vscode.window.showWarningMessage(
            'Message dropped — no session available to receive it. Start a new agent task to continue.',
          );
          break;
        case 'queued_resume_failed':
          await vscode.window.showInformationMessage(
            'Message queued. Auto-resume failed — start a new agent task to continue.',
          );
          break;
        default:
          break;
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
  registerCommands(context, [
    {
      id: 'texra.sendFollowUp',
      handler: async (payload: {
        stream: StreamTabId;
        text: string;
        mediaFiles?: string[];
      }) => {
        const { stream: streamId, text, mediaFiles } = payload;

        await lazyDetectWaitingStatus(streamId);

        const result = await sendFollowUp(streamId, text, mediaFiles);
        await handleFollowUpResult(result, streamId);
      },
    },
  ]);
}
