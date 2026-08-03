// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { ModelHandlerCompatibilityKeySchema } from '@agent/runtime/modelHandlerCompatibilityKey';
import { runAgent } from '@agent/runtime/runAgent';
import { openFinalOutputIfAvailable } from '@frontend/agents/finalOutputOpener';
import * as logger from '@logger/logUtils';
import type { CopilotRouteOverride } from '@model/copilotRouting';
import { ExecutionIdSchema } from '@shared/schemas';

const CHANNEL = 'ExecuteCommand';

/** Fields common to both the fresh and resume execute-input shapes. */
const ExecuteInputFieldsSchema = z.object({
  config: AgentConfigSchema,
  preferHelperModel: z.boolean().optional(),
  modelHandlerCompatibilityKey: ModelHandlerCompatibilityKeySchema.nullish(),
  copilotRouteOverride: z.literal('direct').optional(),
});

const FreshExecuteInputSchema = ExecuteInputFieldsSchema.extend({
  mode: z.literal('fresh'),
});

const ResumeExecuteInputSchema = ExecuteInputFieldsSchema.extend({
  mode: z.literal('resume'),
  executionId: ExecutionIdSchema,
});

/**
 * Normalizes the two accepted call shapes into a `mode`-tagged bag so the
 * fresh/resume contract can be validated by a real discriminated union
 * instead of an ad hoc `'config' in input` duck-check + cast:
 *
 * - A bare `AgentConfig` (no `config` property of its own — see
 *   `AgentConfigSharedFieldsSchema`) is always a fresh execution.
 * - `{ config, executionId?, ... }` is fresh when `executionId` is absent
 *   and resume when present (`runAgent` uses that same presence check to
 *   decide whether to mint a new `executionId` or reuse one).
 */
function normalizeExecuteInput(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }
  const bag: Record<string, unknown> =
    'config' in input
      ? { ...(input as Record<string, unknown>) }
      : { config: input };
  return {
    ...bag,
    mode: bag.executionId != null ? 'resume' : 'fresh',
  };
}

const ExecuteInputSchema = z.preprocess(
  normalizeExecuteInput,
  z.discriminatedUnion('mode', [
    FreshExecuteInputSchema,
    ResumeExecuteInputSchema,
  ]),
);

/**
 * `onRun` is a same-process callback reference, not serializable data, so it
 * is carried through structurally rather than Zod-validated like the rest of
 * the payload — mirroring `RunAgentOptions['onRun']` and friends elsewhere in
 * `src/agent/runtime`, which are plain TS-typed callback fields too.
 */
function extractOnRun(input: unknown): (() => void) | undefined {
  if (input === null || typeof input !== 'object' || !('onRun' in input)) {
    return undefined;
  }
  const { onRun } = input as { onRun?: unknown };
  return typeof onRun === 'function' ? (onRun as () => void) : undefined;
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
  const parsed = ExecuteInputSchema.safeParse(input);
  if (!parsed.success) {
    const message = `Invalid agent configuration. ${z.prettifyError(parsed.error)}`;
    logger.warn(CHANNEL, message, { data: parsed.error });
    void vscode.window.showErrorMessage(message);
    return;
  }
  const data = parsed.data;

  // Post-start failures are already logged and surfaced by the run
  // lifecycle; let them propagate rather than adding a second (mislabeled)
  // catch-all here.
  await runAgent(
    {
      config: data.config,
      executionId: data.mode === 'resume' ? data.executionId : undefined,
    },
    {
      openWorkflowOutput: openFinalOutputIfAvailable,
      // Set only by the "fix LaTeX" actions (see handleFixCompilation and the
      // progress-view compile fixer); a direct main-view launch omits it and
      // keeps the user's selected model.
      preferHelperModel: data.preferHelperModel === true,
      modelHandlerCompatibilityKey: data.modelHandlerCompatibilityKey,
      copilotRouteOverride: data.copilotRouteOverride as
        CopilotRouteOverride | undefined,
      onRun: extractOnRun(input),
    },
  );
}
