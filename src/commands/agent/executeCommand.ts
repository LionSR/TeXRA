// Standard library imports
import { randomUUID } from 'crypto';

// Third-party imports
import * as vscode from 'vscode';
import { ZodError } from 'zod';

// Local imports
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { executeAgent } from '@agent/runtime/executeAgent';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import { AgentHistoryManager } from '@common/history';
import * as logger from '@logger/logUtils';

const CHANNEL = 'ExecuteCommand';

// --- Command ---

export function registerExecuteCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.execute', runExecuteCommand),
  );
}

/**
 * Execute an agent with the given configuration.
 * Always starts a new execution - for resuming paused sessions, use texra.resumeAgent.
 */
export async function runExecuteCommand(input: unknown): Promise<void> {
  try {
    // Support both raw config and wrapped { config } format
    const rawConfig = isWrappedConfig(input) ? input.config : input;
    const config = AgentConfigSchema.parse(rawConfig);

    const executionId = randomUUID() as ExecutionId;
    await AgentHistoryManager.addToHistory(executionId, config);
    await executeAgent(config, executionId);
  } catch (error) {
    if (error instanceof ZodError) {
      const detail = error.issues.map((i) => i.message).join('; ');
      logger.warn(CHANNEL, `Invalid agent configuration. ${detail}`, {
        data: error,
      });
      void vscode.window.showErrorMessage(
        `Invalid agent configuration. ${detail}`,
      );
      return;
    }

    logger.error(CHANNEL, 'Agent execution failed before start.', {
      data: error,
    });
    throw error;
  }
}

/** Check if input is wrapped in { config } format */
function isWrappedConfig(input: unknown): input is { config: unknown } {
  return input !== null && typeof input === 'object' && 'config' in input;
}
