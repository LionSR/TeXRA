// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import type { StreamTabId } from '@agent/types/IdentifierTypes';
// Internal imports
import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';

export function registerFollowUpCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texra.sendFollowUp',
      async (payload: { stream: string; text: string }) => {
        const streamId = payload.stream as StreamTabId;
        await sendFollowUp(streamId, payload.text);
      },
    ),
  );
}
