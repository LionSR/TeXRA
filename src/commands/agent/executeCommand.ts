// Standard library imports
import { randomUUID } from 'crypto';

// Third-party imports
import * as vscode from 'vscode';
import { ZodError } from 'zod';

// Local imports
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { executeAgent } from '@agent/runtime/executeAgent';
import { formatZodError } from '@common/errors';
import { AgentHistoryManager } from '@common/history';
import * as logger from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';

const CHANNEL = 'ExecuteCommand';

// --- Command ---

export function registerExecuteCommand(context: vscode.ExtensionContext) {
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
    // Support both raw config and wrapped { config, executionId? } format
    const isWrappedInput =
      input !== null && typeof input === 'object' && 'config' in input;
    const wrapped = isWrappedInput
      ? (input as { config: unknown; executionId?: unknown })
      : null;
    // Parse wrapped.config when wrapped (allows Zod to fail on undefined),
    // otherwise parse input directly
    const config = AgentConfigSchema.parse(wrapped ? wrapped.config : input);

    // Use provided executionId (resume) or create new one (fresh)
    const executionId =
      (wrapped?.executionId as ExecutionId | undefined) ??
      (randomUUID() as ExecutionId);
    const isResume = wrapped?.executionId !== undefined;

    if (!isResume) {
      await AgentHistoryManager.addToHistory(executionId, config);
    }
    await executeAgent(config, executionId);
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
