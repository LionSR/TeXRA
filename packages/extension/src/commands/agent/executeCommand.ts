// Third-party imports
import * as vscode from 'vscode';
import { z, ZodError } from 'zod';

// Local imports
import {
  AgentConfigSchema,
  ModelHandlerCompatibilityKeySchema,
  runAgent,
  type RunAgentOptions,
} from '@agent/runtime';
import { openFinalOutputIfAvailable } from '@frontend/agents/finalOutputOpener';
import { createLog } from '@logger/logUtils';
import { ExecutionIdSchema } from '@shared/schemas';

const log = createLog('ExecuteCommand');

/**
 * The "wrapped" launch shape — `{ config, executionId?, ... }` — as opposed to
 * a bare `AgentConfig` passed directly (see `runExecuteCommand`'s doc
 * comment). `config` is validated separately against `AgentConfigSchema`, so
 * it stays `z.unknown()` here. `onRun` is a live callback, not serializable
 * data, so it is read directly off the input rather than run through Zod.
 */
const WrappedExecuteInputSchema = z.object({
  config: z.unknown(),
  executionId: ExecutionIdSchema.optional(),
  preferHelperModel: z.boolean().optional(),
  modelHandlerCompatibilityKey: ModelHandlerCompatibilityKeySchema.nullish(),
  copilotRouteOverride: z.literal('direct').optional(),
});

/**
 * Execute an agent with the given configuration.
 *
 * Supports two modes:
 * - Fresh execution: Pass raw config or { config } - creates new executionId
 * - Resume workflow: Pass { config, executionId } - reuses executionId to resume
 *
 * Tool-use sessions resume through `tryResumeFromResumeData` instead.
 */
export async function runExecuteCommand(input: unknown): Promise<void> {
  try {
    const isWrapped =
      input !== null && typeof input === 'object' && 'config' in input;
    const wrapped = isWrapped ? WrappedExecuteInputSchema.parse(input) : null;
    const config = AgentConfigSchema.parse(wrapped ? wrapped.config : input);
    // Not data, so it bypasses the Zod schema above — see that schema's doc.
    const onRun = isWrapped
      ? (input as { onRun?: () => void }).onRun
      : undefined;

    const request = wrapped?.executionId
      ? ({ kind: 'resume', config, executionId: wrapped.executionId } as const)
      : ({ kind: 'fresh', config } as const);
    await runAgent(request, {
      openWorkflowOutput: openFinalOutputIfAvailable,
      // Set only by the "fix LaTeX" actions (see handleFixCompilation and the
      // progress-view compile fixer); a direct main-view launch omits it and
      // keeps the user's selected model.
      preferHelperModel: wrapped?.preferHelperModel === true,
      modelHandlerCompatibilityKey: wrapped?.modelHandlerCompatibilityKey,
      copilotRouteOverride: wrapped?.copilotRouteOverride,
      onRun,
    });
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
