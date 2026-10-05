// Third-party imports
import { Effect, Layer } from 'effect';

// Local imports
import { fakeSetupPlatform } from '@test/support/setupPlatform';
import type { TerminalRunResult } from '@texra/hosts/uiHosts';
import {
  SetupPlatform,
  type SetupPlatformShape,
} from '@texra/tools/setup/platform';

/** `layer` with the setup plugin's service over the installed host's setup
 *  platform, for a setup tool called outside a run's step. */
export const withSetup = <A, E, R>(
  layer: Layer.Layer<A, E, R>,
): Layer.Layer<A | SetupPlatform, E, R> =>
  Layer.merge(layer, SetupPlatform.layer(fakeSetupPlatform));

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
    extensions: {
      isInstalled() {
        return false;
      },
      install: () => Effect.void,
      ...overrides.extensions,
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
