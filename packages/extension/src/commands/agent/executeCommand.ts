// Third-party imports
import * as vscode from 'vscode';
import { ZodError } from 'zod';

// Local imports
import { AgentConfigSchema } from '@agent/core';
import { runValidatedExecutionRequest } from '@agent/runtime/runExecutionRequest';
import { formatZodError } from '@common/errors';
import { openFinalOutputIfAvailable } from '@frontend/agents/finalOutputOpener';
import * as logger from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';

const CHANNEL = 'ExecuteCommand';

/**
 * `texra.execute` migrated to the shared command registry in #3781 batch
 * 4 (handler is `runExecuteCommand`). Kept as a no-op for backward
 * compatibility with the existing call list in `commands.ts`.
 */
export function registerExecuteCommand(
  _context: vscode.ExtensionContext,
): void {
  // Intentionally empty: handler moved to the shared registry (#3781 batch 4).
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

    const executionId = wrapped?.executionId as ExecutionId | undefined;
    await runValidatedExecutionRequest(
      { config, executionId },
      { openWorkflowOutput: openFinalOutputIfAvailable },
    );
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
