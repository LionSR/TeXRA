// Third-party imports
import { Effect, Schema } from 'effect';

// Local imports
import { decodeLaunchConfig } from '@texra/controllers/session/launchConfig';
import type { HostRunActions } from '@texra/controllers/session/hostRunActions';

/**
 * The "wrapped" launch shape, `{ config, ... }`, as opposed to a bare
 * `AgentConfig` passed directly (see `runExecuteCommand`'s doc comment).
 * `config` is decoded by `decodeLaunchConfig`, so it stays `Schema.Unknown`
 * here.
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
  // A configuration that does not decode fails the command with the
  // launch's rejection, so its caller hears it instead of a finished launch
  // that never started. A malformed wrapper (a non-boolean
  // `preferHelperModel`) is a bad command argument, not a launch: it fails
  // with its own schema error.
  const wrapped =
    input !== null && typeof input === 'object' && 'config' in input
      ? yield* Schema.decodeUnknownEffect(WrappedExecuteInputSchema)(input)
      : null;
  const config = yield* decodeLaunchConfig(wrapped ? wrapped.config : input);

  const run = yield* launch(
    config,
    // Set only by the "fix LaTeX" actions (see handleFixCompilation and the
    // progress-view compile fixer); a direct main-view launch omits it and
    // keeps the user's selected model.
    { helperModel: wrapped?.preferHelperModel ?? false },
  );
  yield* run.result;
});
