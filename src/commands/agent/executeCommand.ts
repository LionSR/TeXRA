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
    const wrapped = isWrappedConfig(input) ? input : null;
    const rawConfig = wrapped ? wrapped.config : input;
    const config = AgentConfigSchema.parse(rawConfig);

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

/** Check if input is wrapped in { config, executionId? } format */
function isWrappedConfig(
  input: unknown,
): input is { config: unknown; executionId?: unknown } {
  return input !== null && typeof input === 'object' && 'config' in input;
}
