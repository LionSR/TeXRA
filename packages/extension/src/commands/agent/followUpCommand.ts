// Third-party imports
import * as vscode from 'vscode';

// Local imports
import {
  presentFollowUpWakeResult,
  repairFollowUpWaitingStatus,
  sendFollowUp,
  wakeQueuedFollowUpStream,
  type SendFollowUpResult,
} from '@agent/followUp/ToolUseFollowUp';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { registerCommands } from '@commands/_shared/registerCommands';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import type { StreamTabId } from '@shared/schemas';

function emitQueuedFollowUpsChanged(streamId: StreamTabId): void {
  defaultSession().events.emit({
    scope: 'session',
    event: {
      type: 'updateQueuedFollowUps',
      payload: { streamId },
    },
  });
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

        await repairFollowUpWaitingStatus(
          streamId,
          ProgressViewProvider.getInstance()?.state?.snapshots.getExecutionId(
            streamId,
          ),
          defaultSession(),
        );

        const result = await sendFollowUp(streamId, text, mediaFiles);
        await handleFollowUpResult(result, streamId);
      },
    },
  ]);
}
