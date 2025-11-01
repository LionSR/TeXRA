// Third-party imports
import * as vscode from 'vscode';
import { ZodError } from 'zod';

// Local imports - agent runtime
import { parseAgentConfig } from '@agent/core/AgentConfig';
import { executeAgent } from '@agent/runtime/executeAgent';
import type { ExecutionId } from '@agent/types/IdentifierTypes';

// Local imports - history
import { AgentHistoryManager } from '@historyView/managers';

// Local imports - logging
import * as logger from '@logger/logUtils';

const CHANNEL = 'ExecuteCommand';

// Add the registration function
export function registerExecuteCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.execute', (config: unknown) =>
      executeCommand.executeCommand(config),
    ),
  );
}

export const executeCommand = {
  async executeCommand(config: unknown) {
    try {
      const normalizedConfig = parseAgentConfig(config);
      const executionId: ExecutionId =
        await AgentHistoryManager.addToHistory(normalizedConfig);

      await executeAgent(normalizedConfig, executionId);
    } catch (error) {
      if (error instanceof ZodError) {
        const detail = error.issues.map((issue) => issue.message).join('; ');
        const message =
          'Invalid agent configuration provided for execution.' +
          (detail ? ` ${detail}` : '');
        logger.warn(CHANNEL, message, undefined, undefined, false, error);
        void vscode.window.showErrorMessage(message);
        return;
      }

      logger.error(
        CHANNEL,
        'Agent execution failed before start.',
        undefined,
        undefined,
        false,
        error,
      );
      throw error;
    }
  },
};
