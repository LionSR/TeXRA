// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import {
  requestRuntimeFollowUp,
  type RuntimeFollowUpResult,
} from '@agent/runtime/followUpCommands';
import { emitQueuedFollowUps } from '@agent/runtime/queuedFollowUps';
import {
  isRuntimeStreamActiveOrResuming,
  releaseQueuedFollowUpsForStreams,
} from '@agent/runtime/streamControl';
import { detectRuntimePersistedToolUseWaitingSession } from '@agent/runtime/resumeCommands';
import { registerCommands } from '@commands/_shared/registerCommands';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import type { StreamTabId } from '@shared/schemas';

import { tryResumeFromSnapshot } from './resumeFromSnapshot';

async function lazyDetectWaitingStatus(
  streamId: StreamTabId,
): Promise<boolean> {
  const executionId =
    ProgressViewProvider.getInstance()?.state?.snapshots.getExecutionId(
      streamId,
    );
  return detectRuntimePersistedToolUseWaitingSession({
    streamId,
    executionId,
    runtimeHost: extensionAgentRuntimeHost,
  });
}

async function handleFollowUpResult(
  result: RuntimeFollowUpResult,
  streamId: StreamTabId,
): Promise<void> {
  switch (result.status) {
    case 'sent':
      emitQueuedFollowUps(extensionAgentRuntimeHost, streamId);
      break;
    case 'queued':
      emitQueuedFollowUps(extensionAgentRuntimeHost, streamId);
      if (result.reason === 'waiting' || result.reason === 'children_running') {
        const resumed = await tryResumeFromSnapshot(streamId);
        // tryResumeFromSnapshot also returns false when the stream is
        // already active/resuming — another consumer is on the way, so
        // neither branch below should drop the queue or warn the user.
        if (!resumed && !isRuntimeStreamActiveOrResuming(streamId)) {
          if (result.reason === 'children_running') {
            // sendFollowUp force-reopened a released queue on behalf of the
            // auto-resume attempt. Re-release drops the just-enqueued message
            // too, but that's the lesser evil — leaving the queue open would
            // leak late child deliveries into the next run on this stream.
            releaseQueuedFollowUpsForStreams([streamId]);
            emitQueuedFollowUps(extensionAgentRuntimeHost, streamId);
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

        const result = await requestRuntimeFollowUp({
          streamId,
          text,
          mediaFiles,
        });
        await handleFollowUpResult(result, streamId);
      },
    },
  ]);
}
