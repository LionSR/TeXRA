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

describe('buildUpdateCommand', () => {
  it('produces the matching install invocation per manager', () => {
    expect(buildUpdateCommand('npm')).toEqual({
      command: 'npm',
      args: ['install', '-g', '@texra-ai/cli@latest'],
    });
    expect(buildUpdateCommand('pnpm')).toEqual({
      command: 'pnpm',
      args: ['add', '-g', '@texra-ai/cli@latest'],
    });
    expect(buildUpdateCommand('yarn')).toEqual({
      command: 'yarn',
      args: ['global', 'add', '@texra-ai/cli@latest'],
    });
    expect(buildUpdateCommand('bun')).toEqual({
      command: 'bun',
      args: ['add', '-g', '@texra-ai/cli@latest'],
    });
    // Homebrew upgrades through brew, not the npm registry; refresh the tap
    // first so the just-detected version is actually available locally.
    expect(buildUpdateCommand('brew')).toEqual({
      command: 'brew',
      args: ['update', '&&', 'brew', 'upgrade', 'texra'],
    });
  });
});

describe('fetchLatestCliVersion', () => {
  it.each([
    {
      name: 'returns the version field from the latest dist-tag',
      fetchImpl: async () => jsonResponse({ version: '9.9.9' }),
      expected: '9.9.9',
    },
    {
      name: 'returns undefined on non-ok responses',
      fetchImpl: async () => jsonResponse({ version: '9.9.9' }, 500),
      expected: undefined,
    },
    {
      name: 'returns undefined when the fetch throws (offline)',
      fetchImpl: async () => {
        throw new Error('offline');
      },
      expected: undefined,
    },
    {
      name: 'returns undefined when the body lacks a version',
      fetchImpl: async () => jsonResponse({}),
      expected: undefined,
    },
  ])('$name', async ({ fetchImpl, expected }) => {
    await expect(
      fetchLatestCliVersion({ fetchImpl: fetchImpl as typeof fetch }),
    ).resolves.toBe(expected);
  });
});

describe('fetchLatestHomebrewFormulaVersion', () => {
  it('returns the stable formula version from brew info JSON', async () => {
    await expect(
      fetchLatestHomebrewFormulaVersion({
        runCommand: async () =>
          JSON.stringify({
            formulae: [
              {
                name: 'texra',
                versions: { stable: '0.39.0' },
              },
            ],
          }),
      }),
    ).resolves.toEqual({ version: '0.39.0', refreshed: true });
  });

  it('returns no version when brew info is unavailable or missing the formula', async () => {
    await expect(
      fetchLatestHomebrewFormulaVersion({
        runCommand: async () => undefined,
      }),
    ).resolves.toEqual({ version: undefined, refreshed: false });
    await expect(
      fetchLatestHomebrewFormulaVersion({
        runCommand: async () => JSON.stringify({ formulae: [] }),
      }),
    ).resolves.toEqual({ version: undefined, refreshed: true });
  });

  it('still reads formula info when the Homebrew tap refresh fails, marked stale', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    await expect(
      fetchLatestHomebrewFormulaVersion({
        runCommand: async (command, args) => {
          calls.push({ command, args });
          if (args[0] === 'update') return undefined;
          return JSON.stringify({
            formulae: [{ name: 'texra', versions: { stable: '0.39.0' } }],
          });
        },
      }),
    ).resolves.toEqual({ version: '0.39.0', refreshed: false });

    expect(calls).toEqual([
      { command: 'brew', args: ['update', '--quiet'] },
      { command: 'brew', args: ['info', '--json=v2', 'texra'] },
    ]);
  });

  it('passes the formula and timeout through to the command runner', async () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      timeoutMs: number;
      cwd?: string;
    }> = [];
    await fetchLatestHomebrewFormulaVersion({
      formula: 'custom',
      timeoutMs: 123,
      cwd: '/workspace',
      runCommand: async (command, args, timeoutMs, cwd) => {
        calls.push({ command, args, timeoutMs, cwd });
        return JSON.stringify({
          formulae: [{ name: 'custom', versions: { stable: '1.2.3' } }],
        });
      },
    });

    expect(calls).toEqual([
      {
        command: 'brew',
        args: ['update', '--quiet'],
        timeoutMs: 123,
        cwd: '/workspace',
      },
      {
        command: 'brew',
        args: ['info', '--json=v2', 'custom'],
        timeoutMs: 123,
        cwd: '/workspace',
      },
    ]);
  });
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

  it('runs the check at most once per process', async () => {
    await notifyCliUpdate(context);
    await notifyCliUpdate(context);

    expect(mocks.readCliAmbientState).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh check once the latch is cleared', async () => {
    await notifyCliUpdate(context);
    resetCliUpdateNotifyLatchForTests();
    await notifyCliUpdate(context);

    expect(mocks.readCliAmbientState).toHaveBeenCalledTimes(2);
  });
});
