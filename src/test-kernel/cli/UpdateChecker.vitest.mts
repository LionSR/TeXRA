import { describe, expect, it } from 'vitest';

import {
  buildUpdateCommand,
  detectInstallMethod,
  fetchLatestCliVersion,
  fetchLatestHomebrewFormulaVersion,
  formatUpdateCommand,
  isNewerVersion,
  isPackageManagerInstall,
} from '@cli/runtime/updateChecker';

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
    // npm/pnpm/yarn/bun globals all live under node_modules.
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
  });

  it('treats a Homebrew Cellar install as managed even without node_modules', () => {
    // The tap formula installs the bundled binary under Cellar/<v>/, which need
    // not contain a node_modules segment — the `cellar` segment marks it (same
    // path shape detectInstallMethod recognizes as brew).
    const brewPath =
      '/opt/homebrew/Cellar/texra/0.38.10/libexec/dist/bin/texra.js';
    expect(brewPath.toLowerCase().includes('node_modules')).toBe(false);
    expect(isPackageManagerInstall(brewPath)).toBe(true);
    expect(detectInstallMethod(brewPath)).toBe('brew');
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
    const devPath = '/Users/me/projects/texra/packages/cli/dist/bin/texra.js';
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
