// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUpCoordinator';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

const CHANNEL = 'followUpCommand';
console.log(`[${CHANNEL}] command registered`);

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
