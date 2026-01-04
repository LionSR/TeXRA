// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import {
  sendFollowUp,
  type SendFollowUpResult,
} from '@agent/toolUse/ToolUseFollowUp';
import {
  showErrorMessage,
  showWarningMessage,
} from '@frontend/ui/messageUtils';

/**
 * Handle follow-up result and show appropriate UI notifications.
 *
 * This is the VS Code integration layer - it converts pure result types
 * to VS Code notifications.
 */
async function handleFollowUpResult(result: SendFollowUpResult): Promise<void> {
  switch (result.status) {
    case 'sent':
    case 'queued':
      // Silent success - no notification needed
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
        await handleFollowUpResult(result);
      },
    ),
  );
}
