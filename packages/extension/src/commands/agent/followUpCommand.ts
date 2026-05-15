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
import { hasPersistedFlowRecord } from '@agent/storage/detectWaitingStreams';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { AgentLogger } from '@logger/AgentLogger';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { STREAM_STATUS } from '@shared/schemas';
import type { StreamTabId } from '@shared/schemas';

import { tryResumeFromSnapshot } from './resumeFromSnapshot';

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
        const resumed = await tryResumeFromSnapshot(streamId);
        // tryResumeFromSnapshot also returns false when the stream is
        // already active/resuming — another consumer is on the way, so
        // neither branch below should drop the queue or warn the user.
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
