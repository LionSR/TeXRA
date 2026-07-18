// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { deriveResumability } from '@agent/storage';
import { createChannelTrace } from '@agent/trace';
import {
  presentFollowUpWakeResult,
  sendFollowUp,
  wakeQueuedFollowUpStream,
  type SendFollowUpResult,
} from '@agent/followUp/ToolUseFollowUp';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { registerCommands } from '@commands/_shared/registerCommands';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { STREAM_PHASE } from '@shared/schemas';
import type { StreamTabId } from '@shared/schemas';
import { isInFlightPhase } from '@shared/streams/streamStatus';

const logger = createChannelTrace('followUpCommand');

const inFlightDetections = new Set<StreamTabId>();

function emitQueuedFollowUpsChanged(streamId: StreamTabId): void {
  defaultSession().events.emit({
    scope: 'session',
    event: {
      type: 'updateQueuedFollowUps',
      payload: { streamId },
    },
  });
}

async function lazyDetectWaitingStatus(
  streamId: StreamTabId,
): Promise<boolean> {
  const currentStatus = defaultSession().status.get(streamId);
  if (currentStatus === STREAM_PHASE.WAITING) {
    return true;
  }
  if (isInFlightPhase(currentStatus)) {
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
      const repaired = defaultSession().status.transitionToWaiting(
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
      emitQueuedFollowUpsChanged(streamId);
      break;
    case 'queued':
      emitQueuedFollowUpsChanged(streamId);
      {
        const presentation = presentFollowUpWakeResult(
          await wakeQueuedFollowUpStream(streamId, result),
        );
        if (presentation.severity === 'warning') {
          if (presentation.refreshQueuedFollowUps) {
            emitQueuedFollowUpsChanged(streamId);
          }
          await vscode.window.showWarningMessage(presentation.message);
        } else if (presentation.severity === 'info') {
          if (presentation.refreshQueuedFollowUps) {
            emitQueuedFollowUpsChanged(streamId);
          }
          await vscode.window.showInformationMessage(presentation.message);
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
