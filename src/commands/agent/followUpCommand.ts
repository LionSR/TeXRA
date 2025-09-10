// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { BaseAgent } from '@agent/implementations/BaseAgent';

// Local imports - utilities
import { showLoggedErrorMessage } from '@common/errors/errorHandlingUtils';

const CHANNEL = 'followUpCommand';
console.log(`[${CHANNEL}] command registered`);

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
            await showLoggedErrorMessage(
              CHANNEL,
              'Failed to send follow-up',
              err,
            );
          }
        }
      },
    ),
  );
}
