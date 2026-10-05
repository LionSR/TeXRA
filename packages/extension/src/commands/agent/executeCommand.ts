// Third-party imports
import { Effect } from 'effect';
import { z, ZodError } from 'zod';

// Local imports
import { AgentConfigSchema, type SessionHandle } from '@agent/runtime';
import type { SessionBackend } from '@controllers/session/sessionBackend';
import { openFinalOutputIfAvailable } from '@frontend/agents/finalOutputOpener';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessServices } from '@platform/processRuntime';
import type { RunId } from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';

const CHANNEL = 'ExecuteCommand';

/**
 * The "wrapped" launch shape — `{ config, ... }` — as opposed to
 * a bare `AgentConfig` passed directly (see `runExecuteCommand`'s doc
 * comment). `config` is validated separately against `AgentConfigSchema`, so
 * it stays `z.unknown()` here.
 */
const WrappedExecuteInputSchema = z.object({
  config: z.unknown(),
  preferHelperModel: z.boolean().optional(),
  ownApiKeyFallback: z.boolean().optional(),
});

/**
 * Execute a fresh run of an agent with the given configuration: a raw
 * config or `{ config }`. A persisted run resumes through
 * `resumeOnSession` instead.
 *
 * The launch is the Effect this returns: the extension's command surface
 * settles it on the host entry's runtime.
 */
export const runExecuteCommand = Effect.fn('runExecuteCommand')(function* (
  input: unknown,
  session: SessionHandle,
  /** Where the run runs: this window's session, or the service's. */
  backend: SessionBackend,
  /** Select the run this launch resolved: the launching surface's own. */
  onRunResolved: (runId: RunId) => void,
): Effect.fn.Return<void, Error, ProcessServices> {
  // A configuration that does not parse fails the command, so its caller
  // hears the refusal instead of a settled launch that never started.
  const { wrapped, config } = yield* Effect.try({
    try: () => {
      const wrapped =
        input !== null && typeof input === 'object' && 'config' in input
          ? WrappedExecuteInputSchema.parse(input)
          : null;
      const config = AgentConfigSchema.parse(wrapped ? wrapped.config : input);
      return { wrapped, config };
    },
    catch: (error) =>
      error instanceof ZodError
        ? new Error(`Invalid agent configuration. ${z.prettifyError(error)}`, {
            cause: error,
          })
        : ensureError(error),
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning(error.message).pipe(withLogChannel(CHANNEL)),
    ),
  );

  // Post-start failures are already logged and surfaced by the run lifecycle,
  // so they travel the failure channel without a second (mislabeled) log entry.
  const result = yield* backend.launch(
    { config },
    {
      // Set only by the "fix LaTeX" actions (see handleFixCompilation and the
      // progress-view compile fixer); a direct main-view launch omits it and
      // keeps the user's selected model.
      preferHelperModel: wrapped?.preferHelperModel ?? false,
      ownApiKeyFallback: wrapped?.ownApiKeyFallback,
      onRunResolved,
    },
  );
  // Presentation reacts to the committed outcome; it never runs inside the run,
  // and its failure never fails the launch that produced the run.
  yield* openFinalOutputIfAvailable(session.roots)(result).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning('Opening the final output failed', cause).pipe(
        withLogChannel(CHANNEL),
      ),
    ),
  );
});
