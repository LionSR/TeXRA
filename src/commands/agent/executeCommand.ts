// Standard library imports
import { randomUUID } from 'crypto';

// Third-party imports
import * as vscode from 'vscode';
import { z, ZodError } from 'zod';

// Local imports
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { executeAgent } from '@agent/runtime/executeAgent';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import { AgentHistoryManager } from '@common/history';
import * as logger from '@logger/logUtils';

const CHANNEL = 'ExecuteCommand';

// --- Schema ---

/**
 * Explicit wrapper format: { config, executionId?, resume? }
 *
 * Note: `config` is z.unknown() because validation is handled by AgentConfigSchema.parse(),
 * which owns AgentConfigSchema. Errors will surface as ZodError in the catch block.
 */
const ExplicitWrapperSchema = z.object({
  config: z.unknown(),
  executionId: z.string().optional(),
  resume: z.boolean().prefault(false),
});

type ParsedInput = z.infer<typeof ExplicitWrapperSchema>;

/** Check if input looks like an explicit wrapper (has 'config' property) */
function hasConfigProperty(input: unknown): input is { config: unknown } {
  return input !== null && typeof input === 'object' && 'config' in input;
}

/**
 * Parse execute input: explicit wrapper or raw config.
 *
 * Discrimination logic:
 * - If input has 'config' property → parse as explicit wrapper (fail if malformed)
 * - Otherwise → treat entire input as raw config
 */
function parseExecuteInput(input: unknown): ParsedInput {
  if (hasConfigProperty(input)) {
    return ExplicitWrapperSchema.parse(input);
  }
  return { config: input, resume: false };
}

// --- Command ---

export function registerExecuteCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.execute', runExecuteCommand),
  );
}

export async function runExecuteCommand(input: unknown): Promise<void> {
  try {
    const { config, executionId, resume } = parseExecuteInput(input);
    const normalizedConfig = AgentConfigSchema.parse(config);

    if (resume && executionId) {
      await executeAgent(normalizedConfig, executionId, { resume: true });
      return;
    }

    if (resume) {
      logger.warn(
        CHANNEL,
        'Resume requested without execution ID; starting new run.',
      );
    }

    const newExecutionId = randomUUID() as ExecutionId;
    await AgentHistoryManager.addToHistory(newExecutionId, normalizedConfig);
    await executeAgent(normalizedConfig, newExecutionId);
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
