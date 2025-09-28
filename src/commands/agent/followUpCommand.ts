// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { getToolUseAgent } from '@agent/toolUse/ToolUseAgentRegistry';

// Local imports - utilities
import { showLoggedErrorMessage } from '@common/errors/errorHandlingUtils';

const CHANNEL = 'followUpCommand';
console.log(`[${CHANNEL}] command registered`);

export function registerFollowUpCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texra.sendFollowUp',
      async (payload: { stream: string; text: string }) => {
        const agent = getToolUseAgent(payload.stream);
        if (agent) {
          try {
            agent.appendFollowUp(payload.text);
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
