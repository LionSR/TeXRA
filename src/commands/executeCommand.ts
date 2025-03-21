// Third-party imports
import * as vscode from 'vscode';

// Local imports - utilities
import { getConfig } from '../utils/configUtils';

// Local imports - agent components
import { AgentConfig } from '../agent/AgentConfig';
import { executeAgent } from '../agent/executeAgent';

// Local imports - history
import { AgentHistoryManager } from '../historyView/AgentHistoryManager';

// Add the registration function
export function registerExecuteCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('coauthor.execute', (config: AgentConfig) =>
      executeCommand.executeCommand(config, context),
    ),
  );
}

export const executeCommand = {
  executeCommand: async (
    config: AgentConfig,
    context: vscode.ExtensionContext,
  ) => {
    try {
      // Save the agent configuration to history (silently)
      await AgentHistoryManager.addToHistory(context, config);

      // Run the agent directly
      await executeAgent(config, context);
    } catch (err) {
      throw err;
    }
  },
};
