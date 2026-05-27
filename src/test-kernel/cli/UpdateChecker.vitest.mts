import { describe, expect, it } from 'vitest';

import {
  buildUpdateCommand,
  detectInstallMethod,
  fetchLatestCliVersion,
  formatUpdateCommand,
  isNewerVersion,
  parseSemver,
} from '@cli/runtime/updateChecker';

describe('parseSemver', () => {
  it('parses plain and prerelease versions', () => {
    expect(parseSemver('1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: '',
    });
    expect(parseSemver('v0.38.2')).toMatchObject({ major: 0, minor: 38 });
    expect(parseSemver('1.2.0-rc.1')?.prerelease).toBe('rc.1');
  });

  it('rejects non-semver strings', () => {
    expect(parseSemver('unknown')).toBeUndefined();
    expect(parseSemver('1.2')).toBeUndefined();
  });
});

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
