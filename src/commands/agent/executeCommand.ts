// Third-party imports
import * as vscode from 'vscode';
import { ZodError } from 'zod';

// Local imports
import { AgentConfigSchema } from '@agent/core';
import { registerExecution } from '@agent/storage';
import { executeAgent } from '@agent/runtime/executeAgent';
import { formatZodError } from '@common/errors';
import { openFinalOutputIfAvailable } from '@frontend/agents/finalOutputOpener';
import * as logger from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';
import { generateExecutionId } from '@utils/core/executionId';

const CHANNEL = 'ExecuteCommand';

export function registerExecuteCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.execute', runExecuteCommand),
  );
}

/**
 * Execute an agent with the given configuration.
 *
 * Supports two modes:
 * - Fresh execution: Pass raw config or { config } - creates new executionId
 * - Resume workflow: Pass { config, executionId } - reuses executionId to resume
 *
 * For tool-use sessions, use texra.resumeAgent with a snapshot instead.
 */
export async function runExecuteCommand(input: unknown): Promise<void> {
  try {
    const isWrappedInput =
      input !== null && typeof input === 'object' && 'config' in input;
    const wrapped = isWrappedInput
      ? (input as { config: unknown; executionId?: unknown })
      : null;
    const config = AgentConfigSchema.parse(wrapped ? wrapped.config : input);

    const executionId =
      (wrapped?.executionId as ExecutionId | undefined) ??
      generateExecutionId();
    const isResume = wrapped?.executionId !== undefined;

    if (!isResume) {
      await registerExecution(executionId, config, config.agent);
    }
    const result = await executeAgent(config, executionId);
    if (result.category === 'workflow') {
      await openFinalOutputIfAvailable(result);
    }
  } catch (error) {
    if (error instanceof ZodError) {
      const message = `Invalid agent configuration. ${formatZodError(error)}`;
      logger.warn(CHANNEL, message, { data: error });
      void vscode.window.showErrorMessage(message);
      return;
    }

    logger.error(CHANNEL, 'Agent execution failed before start.', {
      data: error,
    });
    throw error;
  }
}
