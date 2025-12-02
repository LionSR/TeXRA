// Standard library imports
import { randomUUID } from 'crypto';

// Third-party imports
import * as vscode from 'vscode';
import { z, ZodError } from 'zod';

// Local imports
import { parseAgentConfig } from '@agent/core/AgentConfig';
import { executeAgent, resumeAgentExecution } from '@agent/runtime/executeAgent';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import { AgentHistoryManager } from '@historyView/managers';
import * as logger from '@logger/logUtils';

const CHANNEL = 'ExecuteCommand';

// --- Schema ---

/**
 * Explicit execute input with config field.
 *
 * Note: `config` is z.unknown() because validation is handled by parseAgentConfig(),
 * which owns AgentConfigSchema. Validating here would duplicate that logic.
 * Errors from invalid config will surface as ZodError in the catch block.
 */
const ExplicitInputSchema = z.object({
  config: z.unknown(),
  executionId: z.string().optional(),
  resume: z.boolean().default(false),
});

/** Accepts {config, executionId?, resume?} or raw config directly */
const ExecuteInputSchema = z
  .unknown()
  .transform((input): z.infer<typeof ExplicitInputSchema> => {
    const explicit = ExplicitInputSchema.safeParse(input);
    return explicit.success ? explicit.data : { config: input, resume: false };
  });

// --- Command ---

export function registerExecuteCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.execute', (config: unknown) =>
      executeCommand.executeCommand(config),
    ),
  );
}

export const executeCommand = {
  async executeCommand(input: unknown) {
    try {
      const { config, executionId, resume } = ExecuteInputSchema.parse(input);
      const normalizedConfig = parseAgentConfig(config);

      if (resume && executionId) {
        await resumeAgentExecution(normalizedConfig, executionId);
        return;
      }

      if (resume) {
        logger.warn(CHANNEL, 'Resume requested without execution ID; starting new run.');
      }

      const newExecutionId = randomUUID() as ExecutionId;
      await AgentHistoryManager.addToHistory(newExecutionId, normalizedConfig);
      await executeAgent(normalizedConfig, newExecutionId);
    } catch (error) {
      if (error instanceof ZodError) {
        const detail = error.issues.map((i) => i.message).join('; ');
        logger.warn(CHANNEL, `Invalid agent configuration. ${detail}`, { data: error });
        void vscode.window.showErrorMessage(`Invalid agent configuration. ${detail}`);
        return;
      }

      logger.error(CHANNEL, 'Agent execution failed before start.', { data: error });
      throw error;
    }
  },
};
