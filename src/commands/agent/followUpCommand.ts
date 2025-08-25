// Third-party imports
import * as vscode from 'vscode';

// Local imports - commands
import { BaseAgent } from '@agent/implementations/BaseAgent';

export function registerFollowUpCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texra.sendFollowUp',
      async (payload: { stream: string; text: string }) => {
        const agent = BaseAgent.getRunningAgent(payload.stream);
        if (agent && typeof (agent as any).appendFollowUp === 'function') {
          try {
            (agent as any).appendFollowUp(payload.text);
          } catch (err) {
            console.error(`Failed to send follow-up: ${String(err)}`);
          }
        }
      },
    ),
  );
}
