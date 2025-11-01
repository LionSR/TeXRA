// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent components
import {
  parseAgentConfig,
  } from '@agent/core/AgentConfig';
import { executeAgent } from '@agent/runtime/executeAgent';
import type { ExecutionId } from '@agent/types/IdentifierTypes';

// Local imports - history
import { AgentHistoryManager } from '@historyView/managers';

// Add the registration function
export function registerExecuteCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.execute', (config: unknown) =>
      executeCommand.executeCommand(config, context),
    ),
  );
}

export const executeCommand = {
  executeCommand: async (
    config: unknown,
    context: vscode.ExtensionContext,
  ) => {
    try {
      // Save the agent configuration to history (silently)
      const normalizedConfig = parseAgentConfig(config);
      const executionId: ExecutionId =
        await AgentHistoryManager.addToHistory(normalizedConfig);

      // Run the agent directly, passing through the execution ID
      await executeAgent(normalizedConfig, executionId);
    } catch (err) {
      throw err;
    }
  },
};
