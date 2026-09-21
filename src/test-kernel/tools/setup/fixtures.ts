// Third-party imports
import { Effect } from 'effect';

// Local imports
import type { TerminalRunResult } from '@hosts/uiHosts';
import type { SetupPlatformShape } from '@tools/setup/platform';

/**
 * Build a fully stubbed host-varying setup platform for tool unit tests.
 * Process-global credential, auth, model-access, and config behavior comes
 * from the shared platform and is tested through those canonical surfaces.
 */
export function createFakeSetupPlatform(
  overrides: Partial<SetupPlatformShape> = {},
): SetupPlatformShape {
  return {
    host: overrides.host ?? 'cli',
    signIn: overrides.signIn ?? (() => Effect.succeed(false)),
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
