// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalGitHubToken = process.env.GITHUB_TOKEN;

beforeEach(() => {
  vi.resetModules();
  process.env.GITHUB_TOKEN = 'gh-env-token';
});

afterEach(() => {
  if (originalGitHubToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = originalGitHubToken;
  }
  vi.resetModules();
});

describe('getGitHubToken', () => {
  it('uses the GITHUB_TOKEN fallback before platform initialization', async () => {
    const { getGitHubToken } = await import('@tools/github/githubAuth');

    await expect(getGitHubToken()).resolves.toBe('gh-env-token');
  });

  it('prefers the platform secret when the platform is initialized', async () => {
    const [{ initPlatform }, { createFakePlatform }, githubAuth] =
      await Promise.all([
        import('@platform/platform'),
        import('@test/support/FakePlatform'),
        import('@tools/github/githubAuth'),
      ]);

    initPlatform(
      createFakePlatform({
        secrets: {
          [githubAuth.GITHUB_TOKEN_STORAGE_KEY]: 'gh-secret-token',
        },
      }),
    );

    await expect(githubAuth.getGitHubToken()).resolves.toBe('gh-secret-token');
  });
});
