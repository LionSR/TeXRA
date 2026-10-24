// Third-party imports
import { Effect, Schema } from 'effect';

// Local imports
import { AgentConfigSchema, ensureError } from '@texra-ai/harness/schemas';
import { withLogChannel } from '@texra-ai/harness';
import type { HostRunActions } from '@texra/controllers/session/hostRunActions';

const CHANNEL = 'ExecuteCommand';

/**
 * The "wrapped" launch shape — `{ config, ... }` — as opposed to
 * a bare `AgentConfig` passed directly (see `runExecuteCommand`'s doc
 * comment). `config` is validated separately against `AgentConfigSchema`, so
 * it stays `z.unknown()` here.
 */
const WrappedExecuteInputSchema = Schema.Struct({
  config: Schema.Unknown,
  preferHelperModel: Schema.optional(Schema.Boolean),
});

/**
 * Execute a fresh run of an agent with the given configuration: a raw
 * config or `{ config }`, started on the window's launcher. A persisted run
 * resumes through the session's `resume` instead. The command settles when
 * the run ends.
 */
export const runExecuteCommand = Effect.fn('runExecuteCommand')(function* (
  input: unknown,
  launch: HostRunActions['runValidated'],
) {
  // A configuration that does not parse fails the command, so its caller
  // hears the refusal instead of a settled launch that never started.
  const { wrapped, config } = yield* Effect.try({
    try: () => {
      const wrapped =
        input !== null && typeof input === 'object' && 'config' in input
          ? Schema.decodeUnknownSync(WrappedExecuteInputSchema)(input)
          : null;
      const config = Schema.decodeUnknownSync(AgentConfigSchema)(
        wrapped ? wrapped.config : input,
      );
      return { wrapped, config };
    },
    catch: (error) =>
      error instanceof ZodError
        ? new Error(`Invalid agent configuration. ${error.message}`, {
            cause: error,
          })
        : ensureError(error),
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning(error.message).pipe(withLogChannel(CHANNEL)),
    ),
  );

  const run = yield* launch(
    { config },
    // Set only by the "fix LaTeX" actions (see handleFixCompilation and the
    // progress-view compile fixer); a direct main-view launch omits it and
    // keeps the user's selected model.
    { helperModel: wrapped?.preferHelperModel ?? false },
  );
  yield* run.result;
});
