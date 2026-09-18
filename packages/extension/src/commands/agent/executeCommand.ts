// Third-party imports
import * as vscode from 'vscode';
import { Effect, Result } from 'effect';
import { z, ZodError } from 'zod';

// Local imports
import {
  AgentConfigSchema,
  runAgent,
  type SessionHandle,
} from '@agent/runtime';
import { openFinalOutputIfAvailable } from '@frontend/agents/finalOutputOpener';
import { createLog } from '@logger/logUtils';
import type { ProcessServices } from '@platform/processRuntime';
import { presentLaunchedProgressRun } from '@progressView/progressNavigation';
import { ModelCompatibilityKeySchema, RunIdSchema } from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';

const log = createLog('ExecuteCommand');

/**
 * The "wrapped" launch shape — `{ config, runId?, ... }` — as opposed to
 * a bare `AgentConfig` passed directly (see `runExecuteCommand`'s doc
 * comment). `config` is validated separately against `AgentConfigSchema`, so
 * it stays `z.unknown()` here.
 */
const WrappedExecuteInputSchema = z.object({
  config: z.unknown(),
  runId: RunIdSchema.optional(),
  preferHelperModel: z.boolean().optional(),
  modelCompatibilityKey: ModelCompatibilityKeySchema.nullish(),
  ownApiKeyFallback: z.boolean().optional(),
});

/**
 * Execute an agent with the given configuration.
 *
 * Supports two modes:
 * - Fresh run: Pass raw config or { config } - creates new runId
 * - Resume workflow: Pass { config, runId } - reuses runId to resume
 *
 * Tool-use sessions resume through `tryResumeFromResumeData` instead.
 *
 * The launch is the Effect this returns: the extension's command surface
 * settles it on the host entry's runtime, and `tryResumeFromResumeData`
 * composes it into the resume program that already runs on one.
 */
export const runExecuteCommand = Effect.fn('runExecuteCommand')(function* (
  input: unknown,
  session: SessionHandle,
): Effect.fn.Return<void, Error, ProcessServices> {
  const parsed = yield* Effect.result(
    Effect.try({
      try: () => {
        const wrapped =
          input !== null && typeof input === 'object' && 'config' in input
            ? WrappedExecuteInputSchema.parse(input)
            : null;
        const config = AgentConfigSchema.parse(
          wrapped ? wrapped.config : input,
        );
        return { wrapped, config };
      },
      catch: ensureError,
    }),
  );
  if (Result.isFailure(parsed)) {
    const error = parsed.failure;
    if (error instanceof ZodError) {
      const message = `Invalid agent configuration. ${z.prettifyError(error)}`;
      log.warn(message, { data: error });
      void vscode.window.showErrorMessage(message);
      return;
    }
    return yield* Effect.fail(error);
  }
  const { wrapped, config } = parsed.success;

  const request = wrapped?.runId
    ? ({ kind: 'resume', config, runId: wrapped.runId } as const)
    : ({ kind: 'fresh', config } as const);
  // Post-start failures are already logged and surfaced by the run lifecycle,
  // so they travel the failure channel without a second (mislabeled) log entry.
  yield* runAgent(request, {
    session,
    openWorkflowOutput: openFinalOutputIfAvailable,
    // Set only by the "fix LaTeX" actions (see handleFixCompilation and the
    // progress-view compile fixer); a direct main-view launch omits it and
    // keeps the user's selected model.
    preferHelperModel: wrapped?.preferHelperModel ?? false,
    modelCompatibilityKey: wrapped?.modelCompatibilityKey,
    ownApiKeyFallback: wrapped?.ownApiKeyFallback,
    onRunResolved: presentLaunchedProgressRun,
  });
});
