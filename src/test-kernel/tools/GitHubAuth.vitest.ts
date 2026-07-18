// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installPlatform } from '@test/support/setupPlatform';

const originalGitHubToken = process.env.GITHUB_TOKEN;
const originalGhToken = process.env.GH_TOKEN;

beforeEach(() => {
  vi.resetModules();
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
});

afterEach(() => {
  if (originalGitHubToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = originalGitHubToken;
  }
  if (originalGhToken === undefined) {
    delete process.env.GH_TOKEN;
  } else {
    process.env.GH_TOKEN = originalGhToken;
  }
  vi.resetModules();
});

describe('getGitHubToken', () => {
  it('uses the GITHUB_TOKEN fallback before platform initialization', async () => {
    process.env.GITHUB_TOKEN = 'github-env-token';

    const { getGitHubToken } = await import('@tools/github/githubAuth');

    await expect(getGitHubToken()).resolves.toBe('github-env-token');
  });

  it('uses the GH_TOKEN fallback before platform initialization', async () => {
    process.env.GH_TOKEN = 'gh-env-token';

    const { getGitHubToken } = await import('@tools/github/githubAuth');

    await expect(getGitHubToken()).resolves.toBe('gh-env-token');
  });

  it('prefers GH_TOKEN over GITHUB_TOKEN', async () => {
    process.env.GITHUB_TOKEN = 'github-env-token';
    process.env.GH_TOKEN = 'gh-env-token';

    const { getGitHubToken } = await import('@tools/github/githubAuth');

    await expect(getGitHubToken()).resolves.toBe('gh-env-token');
  });

  it('ignores blank environment token values', async () => {
    process.env.GITHUB_TOKEN = '   ';
    process.env.GH_TOKEN = 'gh-env-token';

    const { getGitHubToken } = await import('@tools/github/githubAuth');

    await expect(getGitHubToken()).resolves.toBe('gh-env-token');
  });

  it('prefers the platform secret when the platform is initialized', async () => {
    process.env.GITHUB_TOKEN = 'github-env-token';
    process.env.GH_TOKEN = 'gh-env-token';

    const githubAuth = await import('@tools/github/githubAuth');

    await installPlatform({
      secrets: {
        [githubAuth.GITHUB_TOKEN_STORAGE_KEY]: 'gh-secret-token',
      },
    });

    await expect(githubAuth.getGitHubToken()).resolves.toBe('gh-secret-token');
  });

  it('ignores blank platform secrets before using environment fallbacks', async () => {
    const githubAuth = await import('@tools/github/githubAuth');

    await installPlatform({
      secrets: {
        [githubAuth.GITHUB_TOKEN_STORAGE_KEY]: '   ',
      },
      secretsEnv: { GH_TOKEN: 'gh-env-token' },
    });

    await expect(githubAuth.getGitHubToken()).resolves.toBe('gh-env-token');
  });
});

describe('resolveGitHubTokenSource', () => {
  it('reports "secret" when a persisted token exists, even with env vars set', async () => {
    const githubAuth = await import('@tools/github/githubAuth');

    await installPlatform({
      secrets: {
        [githubAuth.GITHUB_TOKEN_STORAGE_KEY]: 'gh-secret-token',
      },
      secretsEnv: {
        GH_TOKEN: 'gh-env-token',
        GITHUB_TOKEN: 'github-env-token',
      },
    });

    const { platform } = await import('@platform/platform');

    await expect(
      githubAuth.resolveGitHubTokenSource(platform().secrets),
    ).resolves.toBe('secret');
  });

  it('reports "env" when no persisted token exists but an env var does', async () => {
    const githubAuth = await import('@tools/github/githubAuth');

    await installPlatform({
      secretsEnv: { GH_TOKEN: 'gh-env-token' },
    });

    const { platform } = await import('@platform/platform');

    await expect(
      githubAuth.resolveGitHubTokenSource(platform().secrets),
    ).resolves.toBe('env');
  });

  it('reports "none" when neither a persisted token nor an env var exists', async () => {
    const githubAuth = await import('@tools/github/githubAuth');

    await installPlatform({});

    const { platform } = await import('@platform/platform');

    await expect(
      githubAuth.resolveGitHubTokenSource(platform().secrets),
    ).resolves.toBe('none');
  });

  it('ignores a blank persisted token and falls back to an env var', async () => {
    const githubAuth = await import('@tools/github/githubAuth');

    await installPlatform({
      secrets: { [githubAuth.GITHUB_TOKEN_STORAGE_KEY]: '   ' },
      secretsEnv: { GH_TOKEN: 'gh-env-token' },
    });

    const { platform } = await import('@platform/platform');

    await expect(
      githubAuth.resolveGitHubTokenSource(platform().secrets),
    ).resolves.toBe('env');
  });
});
