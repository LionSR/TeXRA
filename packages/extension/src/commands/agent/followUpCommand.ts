// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { defaultSession } from '@agent/runtime';
import {
  presentFollowUpResult,
  submitFollowUp,
  type SubmitFollowUpResult,
} from '@agent/followUp';
import { registerCommandEntries } from '@commands/_shared/registerCommands';
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
  result: SubmitFollowUpResult,
  streamId: StreamTabId,
): Promise<void> {
  switch (result.status) {
    case 'sent':
      emitQueuedFollowUpsChanged(streamId);
      break;
    case 'queued': {
      emitQueuedFollowUpsChanged(streamId);
      // A queued result presents as 'none' or an 'info' (resume-failed) note;
      // the 'warning' presentation is only produced for 'dropped', which has
      // its own case below.
      const presentation = presentFollowUpResult(result);
      if (presentation.severity === 'info') {
        await vscode.window.showInformationMessage(presentation.message);
      }
      break;
    }
    case 'no_session':
    case 'dropped':
      await vscode.window.showWarningMessage(
        'No active session. Start a new agent task to continue.',
      );
      break;
  }
}

export function registerFollowUpCommand(
  context: vscode.ExtensionContext,
): void {
  registerCommandEntries(context, [
    {
      id: 'texra.sendFollowUp',
      handler: async (payload: {
        stream: StreamTabId;
        text: string;
        mediaFiles?: string[];
      }) => {
        const { stream: streamId, text, mediaFiles } = payload;

        await defaultSession().repairWaitingIfResumable(streamId);

        const result = await submitFollowUp(streamId, {
          text,
          mediaFiles,
        });
        await handleFollowUpResult(result, streamId);
      },
    },
  ]);
}
