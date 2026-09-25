import { it as effectIt } from '@effect/vitest';
import { Effect } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildUpdateCommand,
  detectInstallMethod,
  fetchLatestCliVersion,
  fetchLatestHomebrewFormulaVersion,
  notifyCliUpdate,
  resetCliUpdateNotifyLatchForTests,
} from '@cli/runtime/updateChecker';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { jsonResponse } from '@test/support/fetchTestUtils';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';

const mocks = vi.hoisted(() => ({ readCliAmbientState: vi.fn() }));

vi.mock('@cli/runtime/cliContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/cliContext')>()),
  readCliAmbientState: mocks.readCliAmbientState,
}));

describe('detectInstallMethod', () => {
  it.each([
    // npm/pnpm/yarn/bun globals all install under a node_modules tree; the
    // manager-specific segment is what separates them.
    {
      path: '/Users/me/Library/pnpm/global/5/node_modules/@texra-ai/cli/dist',
      expected: 'pnpm',
    },
    {
      path: '/usr/local/.pnpm/x/node_modules/@texra-ai/cli/dist',
      expected: 'pnpm',
    },
    {
      path: '/Users/me/.config/yarn/global/node_modules/@texra-ai/cli/dist',
      expected: 'yarn',
    },
    // Yarn Classic's global bin: dotted `.yarn` segment.
    {
      path: '/Users/me/.yarn/global/node_modules/@texra-ai/cli/dist',
      expected: 'yarn',
    },
    {
      path: '/Users/me/.bun/install/global/node_modules/@texra-ai/cli/dist',
      expected: 'bun',
    },
    // npm's global layout carries no manager segment, so it is the fallback.
    {
      path: '/usr/local/lib/node_modules/@texra-ai/cli/dist',
      expected: 'npm',
    },
    // Case-insensitive for Windows paths.
    {
      path: 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@texra-ai\\cli\\dist\\bin\\texra.js',
      expected: 'npm',
    },
    // Homebrew's tap formula installs under Cellar/<version>/ with no
    // node_modules segment; `Cellar` alone marks it (Apple Silicon, Intel
    // macOS, Linuxbrew).
    {
      path: '/opt/homebrew/Cellar/texra/0.38.7/libexec/dist/bin/texra.js',
      expected: 'brew',
    },
    {
      path: '/usr/local/Cellar/texra/0.38.7/libexec/dist/bin/texra.js',
      expected: 'brew',
    },
    {
      path: '/home/linuxbrew/.linuxbrew/Cellar/texra/0.38.7/libexec/dist/bin/texra.js',
      expected: 'brew',
    },
    // Homebrew-managed Node hosts plain npm globals — the broader `homebrew` /
    // `linuxbrew` prefix must not be read as a brew formula install.
    {
      path: '/opt/homebrew/lib/node_modules/@texra-ai/cli/dist/bin/texra.js',
      expected: 'npm',
    },
    {
      path: '/home/linuxbrew/.linuxbrew/lib/node_modules/@texra-ai/cli/dist/bin/texra.js',
      expected: 'npm',
    },
    // A source/dev or linked checkout runs straight from packages/cli/dist and
    // was installed by no package manager: an `npm install -g` prompt could
    // not update it, so the update check has to skip entirely.
    {
      path: '/Users/me/projects/texra/packages/cli/dist/bin/texra.js',
      expected: undefined,
    },
    {
      path: '/Users/me/.local/share/texra/dist/bin/texra.js',
      expected: undefined,
    },
  ])('classifies $path as $expected', ({ path, expected }) => {
    expect(detectInstallMethod(path)).toBe(expected);
  });
});

describe('fetchLatestCliVersion', () => {
  effectIt.effect.each([
    {
      name: 'returns the version field from the latest dist-tag',
      impl: async () => jsonResponse({ version: '9.9.9' }),
      expected: '9.9.9',
    },
    {
      name: 'returns undefined on non-ok responses',
      impl: async () => jsonResponse({ version: '9.9.9' }, 500),
      expected: undefined,
    },
    {
      name: 'returns undefined when the fetch throws (offline)',
      impl: async () => {
        throw new Error('offline');
      },
      expected: undefined,
    },
    {
      name: 'returns undefined when the body lacks a version',
      impl: async () => jsonResponse({}),
      expected: undefined,
    },
  ])('$name', ({ impl, expected }) =>
    Effect.gen(function* () {
      expect(yield* fetchLatestCliVersion()).toBe(expected);
    }).pipe(
      Effect.provideService(FetchHttpClient.Fetch, impl as typeof fetch),
      Effect.provide(FetchHttpClient.layer),
    ),
  );
});

describe('fetchLatestHomebrewFormulaVersion', () => {
  effectIt.effect(
    'returns the stable formula version from brew info JSON',
    () =>
      Effect.gen(function* () {
        expect(
          yield* fetchLatestHomebrewFormulaVersion({
            runCommand: () =>
              Effect.succeed(
                JSON.stringify({
                  formulae: [
                    {
                      name: 'texra',
                      versions: { stable: '0.39.0' },
                    },
                  ],
                }),
              ),
          }),
        ).toEqual({ version: '0.39.0', refreshed: true });
      }).pipe(Effect.provide(nodeSpawnerLayer)),
  );

  effectIt.effect(
    'returns no version when brew info is unavailable or missing the formula',
    () =>
      Effect.gen(function* () {
        expect(
          yield* fetchLatestHomebrewFormulaVersion({
            runCommand: () => Effect.succeed(undefined),
          }),
        ).toEqual({ version: undefined, refreshed: false });
        expect(
          yield* fetchLatestHomebrewFormulaVersion({
            runCommand: () => Effect.succeed(JSON.stringify({ formulae: [] })),
          }),
        ).toEqual({ version: undefined, refreshed: true });
      }).pipe(Effect.provide(nodeSpawnerLayer)),
  );

  effectIt.effect(
    'still reads formula info when the Homebrew tap refresh fails, marked stale',
    () =>
      Effect.gen(function* () {
        const calls: Array<{ command: string; args: readonly string[] }> = [];
        expect(
          yield* fetchLatestHomebrewFormulaVersion({
            runCommand: (command, args) =>
              Effect.sync(() => {
                calls.push({ command, args });
                if (args[0] === 'update') return undefined;
                return JSON.stringify({
                  formulae: [{ name: 'texra', versions: { stable: '0.39.0' } }],
                });
              }),
          }),
        ).toEqual({ version: '0.39.0', refreshed: false });

        expect(calls).toEqual([
          { command: 'brew', args: ['update', '--quiet'] },
          { command: 'brew', args: ['info', '--json=v2', 'texra'] },
        ]);
      }).pipe(Effect.provide(nodeSpawnerLayer)),
  );
});

describe('notifyCliUpdate', () => {
  // A CI run returns right after the ambient read, so the number of ambient
  // reads is exactly the number of times the latch let the check start.
  const context = createTestCliContext({ version: '0.39.3' });

  beforeEach(() => {
    resetCliUpdateNotifyLatchForTests();
    mocks.readCliAmbientState.mockReset().mockReturnValue({
      isCi: true,
      stdinIsTty: true,
      stdoutIsTty: true,
      stderrIsTty: true,
      termIsDumb: false,
      stdoutColorEnabled: false,
      stderrColorEnabled: false,
    });
  });

  effectIt.live('runs the check at most once per process', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => notifyCliUpdate(context));
      yield* Effect.promise(() => notifyCliUpdate(context));

      expect(mocks.readCliAmbientState).toHaveBeenCalledTimes(1);
    }),
  );
});
