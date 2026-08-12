// Third-party imports
import * as vscode from 'vscode';
import { z, ZodError } from 'zod';

// Local imports
import { ModelHandlerCompatibilityKeySchema, runAgent } from '@agent/runtime';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { openFinalOutputIfAvailable } from '@frontend/agents/finalOutputOpener';
import { createLog } from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';

const log = createLog('ExecuteCommand');

interface WrappedExecuteInput {
  config: unknown;
  executionId?: ExecutionId;
  preferHelperModel?: boolean;
  modelHandlerCompatibilityKey?: unknown;
  copilotRouteOverride?: unknown;
  onRun?: () => void;
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
    const wrapped =
      input !== null && typeof input === 'object' && 'config' in input
        ? (input as WrappedExecuteInput)
        : null;
    const config = AgentConfigSchema.parse(wrapped ? wrapped.config : input);
    const modelHandlerCompatibilityKey =
      ModelHandlerCompatibilityKeySchema.nullish().parse(
        wrapped?.modelHandlerCompatibilityKey,
      );
    const copilotRouteOverride = z
      .literal('direct')
      .optional()
      .parse(wrapped?.copilotRouteOverride);

    await runAgent(
      { config, executionId: wrapped?.executionId },
      {
        openWorkflowOutput: openFinalOutputIfAvailable,
        // Set only by the "fix LaTeX" actions (see handleFixCompilation and the
        // progress-view compile fixer); a direct main-view launch omits it and
        // keeps the user's selected model.
        preferHelperModel: wrapped?.preferHelperModel === true,
        modelHandlerCompatibilityKey,
        copilotRouteOverride,
        onRun: wrapped?.onRun,
      },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      const message = `Invalid agent configuration. ${z.prettifyError(error)}`;
      log.warn(message, { data: error });
      void vscode.window.showErrorMessage(message);
      return;
    }

    // Post-start failures are already logged and surfaced by the run
    // lifecycle; rethrow without a second (mislabeled) log entry.
    throw error;
  }
}
