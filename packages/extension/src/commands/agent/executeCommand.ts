// Third-party imports
import * as vscode from 'vscode';
import { z, ZodError } from 'zod';

// Local imports
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { ModelHandlerCompatibilityKeySchema } from '@agent/runtime/modelHandlerCompatibilityKey';
import { runAgent } from '@agent/runtime/runAgent';
import { openFinalOutputIfAvailable } from '@frontend/agents/finalOutputOpener';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import * as logger from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';

const CHANNEL = 'ExecuteCommand';

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
        ? (input as {
            config: unknown;
            executionId?: ExecutionId;
            preferHelperModel?: boolean;
            modelHandlerCompatibilityKey?: unknown;
            onRun?: () => void;
          })
        : null;
    const config = AgentConfigSchema.parse(wrapped ? wrapped.config : input);
    const modelHandlerCompatibilityKey =
      wrapped && 'modelHandlerCompatibilityKey' in wrapped
        ? ModelHandlerCompatibilityKeySchema.nullish().parse(
            wrapped.modelHandlerCompatibilityKey,
          )
        : undefined;

    await runAgent(
      { config, executionId: wrapped?.executionId },
      {
        runtimeHost: extensionAgentRuntimeHost,
        openWorkflowOutput: openFinalOutputIfAvailable,
        // Set only by the "fix LaTeX" actions (see handleFixCompilation and the
        // progress-view compile fixer); a direct main-view launch omits it and
        // keeps the user's selected model.
        preferHelperModel: wrapped?.preferHelperModel === true,
        modelHandlerCompatibilityKey,
        onRun: wrapped?.onRun,
      },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      const message = `Invalid agent configuration. ${z.prettifyError(error)}`;
      logger.warn(CHANNEL, message, { data: error });
      void vscode.window.showErrorMessage(message);
      return;
    }

    // Post-start failures are already logged and surfaced by the run
    // lifecycle; rethrow without a second (mislabeled) log entry.
    throw error;
  }
}
