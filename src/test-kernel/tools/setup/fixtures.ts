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
    signIn: overrides.signIn ?? (async () => false),
    commands: {
      async invoke() {},
      ...overrides.commands,
    },
    extensions: {
      isInstalled() {
        return false;
      },
      async install() {},
      ...overrides.extensions,
    },
    terminal: {
      async runCommand(): Promise<TerminalRunResult> {
        return { exitCode: undefined, output: '', timedOut: false };
      },
      ...overrides.terminal,
    },
  };
}
