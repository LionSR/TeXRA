// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
import { executeAgent } from '@agent/runtime/executeAgent';
import type { ExecutionId } from '@agent/types/IdentifierTypes';

// Local imports - history
import { AgentHistoryManager } from '@historyView/managers';

// Add the registration function
export function registerExecuteCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.execute', (config: AgentConfig) =>
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
      const executionId: ExecutionId =
        await AgentHistoryManager.addToHistory(config);

      // Run the agent directly, passing through the execution ID
      await executeAgent(config, executionId);
    } catch (err) {
      throw err;
    }
  },
};
