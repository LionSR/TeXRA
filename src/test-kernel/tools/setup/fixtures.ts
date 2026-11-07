// Third-party imports
import { Effect, Layer } from 'effect';

// Local imports
import { FakeHost } from '@test/support/testKernel';
import type { TerminalRunResult } from '@texra/hosts/uiHosts';
import {
  SetupHost,
  SetupPlatform,
  type SetupPlatformShape,
} from '@texra/tools/setup/platform';

/** `layer` with the setup plugin's services over the fake host's setup
 *  platform (none of its members when it has none), named `host`, for a
 *  setup tool called outside a run's step. */
export const withSetup = <A, E, R>(
  layer: Layer.Layer<A, E, R>,
  host: SetupHost['Service'] = 'vscode',
): Layer.Layer<A | SetupPlatform | SetupHost, E, R | FakeHost> =>
  Layer.mergeAll(
    layer,
    Layer.effect(
      SetupPlatform,
      FakeHost.useSync((fake) => fake.setup ?? {}),
    ),
    Layer.succeed(SetupHost)(host),
  );

/**
 * Build a fully stubbed host-varying setup platform for tool unit tests.
 * Process-global credential, auth, model-access, and config behavior comes
 * from the shared platform and is tested through those canonical surfaces.
 */
export function createFakeSetupPlatform(
  overrides: Partial<SetupPlatformShape> = {},
): SetupPlatformShape {
  return {
    commands: {
      invoke: () => Effect.void,
      ...overrides.commands,
    },
    terminal:
      overrides.terminal ??
      ((): Effect.Effect<TerminalRunResult> =>
        Effect.succeed({
          exitCode: undefined,
          output: '',
          timedOut: false,
        })),
  };
}
