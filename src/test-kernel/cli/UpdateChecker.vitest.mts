import { describe, expect, it } from 'vitest';

import {
  buildRelaunchCommand,
  buildRelaunchEnv,
  buildUpdateCommand,
  detectInstallMethod,
  exitCodeForRelaunchClose,
  fetchLatestCliVersion,
  fetchLatestHomebrewFormulaVersion,
  formatUpdateCommand,
  isNewerVersion,
  isPackageManagerInstall,
} from '@cli/runtime/updateChecker';
import { CliExitCode } from '@cli/runtime/exitCodes';

describe('isNewerVersion', () => {
  it('compares numerically across all components', () => {
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('0.39.0', '0.38.2')).toBe(true);
    expect(isNewerVersion('0.38.3', '0.38.2')).toBe(true);
    expect(isNewerVersion('0.38.2', '0.38.2')).toBe(false);
    expect(isNewerVersion('0.38.1', '0.38.2')).toBe(false);
  });

  it('ranks a release above its prerelease but not vice versa', () => {
    expect(isNewerVersion('1.2.0', '1.2.0-rc.1')).toBe(true);
    expect(isNewerVersion('1.2.0-rc.1', '1.2.0')).toBe(false);
    expect(isNewerVersion('1.2.0-rc.2', '1.2.0-rc.1')).toBe(true);
  });

  it('returns false when either version is unparseable', () => {
    expect(isNewerVersion('1.0.0', 'unknown')).toBe(false);
    expect(isNewerVersion('latest', '1.0.0')).toBe(false);
  });
});

describe('detectInstallMethod', () => {
  it('recognizes pnpm, yarn, and bun global layouts', () => {
    expect(
      detectInstallMethod('/Users/me/Library/pnpm/global/5/node_modules/x'),
    ).toBe('pnpm');
    expect(detectInstallMethod('/usr/local/.pnpm/x/node_modules/x')).toBe(
      'pnpm',
    );
    expect(detectInstallMethod('/Users/me/.config/yarn/global/x')).toBe('yarn');
    // Yarn Classic's global bin: dotted `.yarn` segment.
    expect(detectInstallMethod('/Users/me/.yarn/bin/x')).toBe('yarn');
    expect(detectInstallMethod('/Users/me/.bun/install/global/x')).toBe('bun');
  });

  it('recognizes Homebrew Cellar layouts across platforms', () => {
    // Apple Silicon.
    expect(
      detectInstallMethod(
        '/opt/homebrew/Cellar/texra/0.38.7/libexec/dist/bin/texra.js',
      ),
    ).toBe('brew');
    // Intel macOS.
    expect(
      detectInstallMethod(
        '/usr/local/Cellar/texra/0.38.7/libexec/dist/bin/texra.js',
      ),
    ).toBe('brew');
    // Linuxbrew.
    expect(
      detectInstallMethod(
        '/home/linuxbrew/.linuxbrew/Cellar/texra/0.38.7/libexec/dist/bin/texra.js',
      ),
    ).toBe('brew');
  });

  it('falls back to npm for the unmarked global layout', () => {
    expect(
      detectInstallMethod('/usr/local/lib/node_modules/@texra-ai/cli/dist'),
    ).toBe('npm');
  });

  it('does not treat Homebrew-managed Node npm globals as brew installs', () => {
    expect(
      detectInstallMethod(
        '/opt/homebrew/lib/node_modules/@texra-ai/cli/dist/bin/texra.js',
      ),
    ).toBe('npm');
    expect(
      detectInstallMethod(
        '/home/linuxbrew/.linuxbrew/lib/node_modules/@texra-ai/cli/dist/bin/texra.js',
      ),
    ).toBe('npm');
  });
});

describe('isPackageManagerInstall', () => {
  it('treats node_modules-resident installs as managed', () => {
    // npm/pnpm globals, and Homebrew's Cellar formula, all live under
    // node_modules — the segment that marks a package-manager install.
    expect(
      isPackageManagerInstall(
        '/usr/local/lib/node_modules/@texra-ai/cli/dist/bin/texra.js',
      ),
    ).toBe(true);
    expect(
      isPackageManagerInstall(
        '/Users/me/Library/pnpm/global/5/node_modules/@texra-ai/cli/dist/bin/texra.js',
      ),
    ).toBe(true);
    expect(
      isPackageManagerInstall(
        '/opt/homebrew/Cellar/texra/0.38.10/libexec/lib/node_modules/@texra-ai/cli/dist/bin/texra.js',
      ),
    ).toBe(true);
  });

  it('is case-insensitive for Windows paths', () => {
    expect(
      isPackageManagerInstall(
        'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@texra-ai\\cli\\dist\\bin\\texra.js',
      ),
    ).toBe(true);
  });

  it('treats a source/dev or linked checkout as unmanaged', () => {
    // A dev build runs straight from packages/cli/dist — no node_modules
    // segment — which is exactly why this gate is needed: detectInstallMethod
    // would otherwise fall back to 'npm' and prompt `npm install -g`.
    const devPath =
      '/Users/me/Local/AI-Projects/coauthor/packages/cli/dist/bin/texra.js';
    expect(isPackageManagerInstall(devPath)).toBe(false);
    expect(detectInstallMethod(devPath)).toBe('npm');
    expect(
      isPackageManagerInstall('/Users/me/.local/share/texra/dist/bin/texra.js'),
    ).toBe(false);
  });
});

describe('buildUpdateCommand / formatUpdateCommand', () => {
  it('produces the matching install invocation per manager', () => {
    expect(formatUpdateCommand('npm')).toBe(
      'npm install -g @texra-ai/cli@latest',
    );
    expect(formatUpdateCommand('pnpm')).toBe(
      'pnpm add -g @texra-ai/cli@latest',
    );
    expect(formatUpdateCommand('yarn')).toBe(
      'yarn global add @texra-ai/cli@latest',
    );
    expect(formatUpdateCommand('bun')).toBe('bun add -g @texra-ai/cli@latest');
    // Homebrew upgrades through brew, not the npm registry; refresh the tap
    // first so the just-detected version is actually available locally.
    expect(formatUpdateCommand('brew')).toBe(
      'brew update && brew upgrade texra',
    );
    expect(buildUpdateCommand('npm')).toEqual({
      command: 'npm',
      args: ['install', '-g', '@texra-ai/cli@latest'],
    });
    expect(buildUpdateCommand('brew')).toEqual({
      command: 'brew',
      args: ['update', '&&', 'brew', 'upgrade', 'texra'],
    });
  });
});

describe('buildRelaunchCommand', () => {
  it('re-execs the entrypoint through the running Node, preserving argv', () => {
    expect(
      buildRelaunchCommand(
        '/usr/local/bin/texra',
        ['chat', '--agent', 'research'],
        '/usr/bin/node',
      ),
    ).toEqual({
      command: '/usr/bin/node',
      args: ['/usr/local/bin/texra', 'chat', '--agent', 'research'],
    });
  });

  it('handles a bare launch with no user arguments', () => {
    expect(buildRelaunchCommand('/usr/local/bin/texra', [], 'node')).toEqual({
      command: 'node',
      args: ['/usr/local/bin/texra'],
    });
  });

  it('returns undefined when there is no entrypoint to re-exec', () => {
    expect(buildRelaunchCommand('', ['chat'], 'node')).toBeUndefined();
    expect(buildRelaunchCommand('   ', ['chat'], 'node')).toBeUndefined();
  });
});

describe('buildRelaunchEnv', () => {
  it('preserves the current environment while skipping the redundant update check', () => {
    expect(buildRelaunchEnv({ HOME: '/Users/me' })).toEqual({
      HOME: '/Users/me',
      TEXRA_NO_UPDATE_CHECK: '1',
    });
  });

  it('overwrites an inherited update-check setting for the relaunched process', () => {
    expect(buildRelaunchEnv({ TEXRA_NO_UPDATE_CHECK: '0' })).toEqual({
      TEXRA_NO_UPDATE_CHECK: '1',
    });
  });
});

describe('exitCodeForRelaunchClose', () => {
  it('mirrors the child exit code when one is available', () => {
    expect(exitCodeForRelaunchClose(0, null)).toBe(CliExitCode.Success);
    expect(exitCodeForRelaunchClose(7, 'SIGTERM')).toBe(7);
  });

  it('uses conventional signal exit codes when the child was killed', () => {
    expect(exitCodeForRelaunchClose(null, 'SIGINT')).toBe(
      CliExitCode.Interrupted,
    );
    expect(exitCodeForRelaunchClose(null, 'SIGTERM')).toBe(
      CliExitCode.Terminated,
    );
    expect(exitCodeForRelaunchClose(null, 'SIGKILL')).toBe(137);
  });

  it('falls back to success only when no code or signal was reported', () => {
    expect(exitCodeForRelaunchClose(null, null)).toBe(CliExitCode.Success);
  });
});

describe('fetchLatestCliVersion', () => {
  function jsonResponse(body: unknown, ok = true): Response {
    return {
      ok,
      json: async () => body,
    } as unknown as Response;
  }

  it('returns the version field from the latest dist-tag', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ version: '9.9.9' })) as typeof fetch;
    await expect(fetchLatestCliVersion({ fetchImpl })).resolves.toBe('9.9.9');
  });

  it('returns undefined on non-ok responses', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ version: '9.9.9' }, false)) as typeof fetch;
    await expect(fetchLatestCliVersion({ fetchImpl })).resolves.toBeUndefined();
  });

  it('returns undefined when the fetch throws (offline)', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    await expect(fetchLatestCliVersion({ fetchImpl })).resolves.toBeUndefined();
  });

  it('returns undefined when the body lacks a version', async () => {
    const fetchImpl = (async () => jsonResponse({})) as typeof fetch;
    await expect(fetchLatestCliVersion({ fetchImpl })).resolves.toBeUndefined();
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
    ).resolves.toBe('0.39.0');
  });

  it('returns undefined when brew info is unavailable or missing the formula', async () => {
    await expect(
      fetchLatestHomebrewFormulaVersion({
        runCommand: async () => undefined,
      }),
    ).resolves.toBeUndefined();
    await expect(
      fetchLatestHomebrewFormulaVersion({
        runCommand: async () => JSON.stringify({ formulae: [] }),
      }),
    ).resolves.toBeUndefined();
  });

  it('still reads formula info when the Homebrew tap refresh fails', async () => {
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
    ).resolves.toBe('0.39.0');

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
    }> = [];
    await fetchLatestHomebrewFormulaVersion({
      formula: 'custom',
      timeoutMs: 123,
      runCommand: async (command, args, timeoutMs) => {
        calls.push({ command, args, timeoutMs });
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
      },
      {
        command: 'brew',
        args: ['info', '--json=v2', 'custom'],
        timeoutMs: 123,
      },
    ]);
  });
});
