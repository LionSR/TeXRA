// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { defaultSession } from '@agent/runtime';
import { registerCommandEntries } from '@commands/_shared/registerCommands';
import { submitProgressFollowUp } from '@controllers/progressView/progressFollowUpSubmit';
import type { StreamTabId } from '@shared/schemas';

/**
 * Programmatic follow-up send with no composer behind it. Its one caller is
 * the workflow-file "user modified the suggested output" note posted by
 * ProgressWorkflowFileActionsController (ProgressViewMessageHandler). The
 * progress view's composer does not route through here: its sends carry an
 * admission ack back to the webview via the shared command handlers.
 */
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
        await submitProgressFollowUp({
          session: defaultSession(),
          streamId,
          input: { text, mediaFiles },
          acknowledge: () => {},
          showInfo: (message) => vscode.window.showWarningMessage(message),
        });
      },
    },
  ]);
}
