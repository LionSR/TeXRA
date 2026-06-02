import { describe, expect, it } from 'vitest';

import {
  buildRelaunchCommand,
  buildRelaunchEnv,
  buildUpdateCommand,
  detectInstallMethod,
  exitCodeForRelaunchClose,
  fetchLatestCliVersion,
  formatUpdateCommand,
  isNewerVersion,
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

  it('falls back to npm for the unmarked global layout', () => {
    expect(
      detectInstallMethod('/usr/local/lib/node_modules/@texra-ai/cli/dist'),
    ).toBe('npm');
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
    expect(buildUpdateCommand('npm')).toEqual({
      command: 'npm',
      args: ['install', '-g', '@texra-ai/cli@latest'],
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
