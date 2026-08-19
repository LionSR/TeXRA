import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installPlatform } from '@test/support/setupPlatform';

/** Secret/env fixture for one row of a token-precedence table. */
interface TokenCase {
  readonly name: string;
  /** Real process env, stubbed to prove tokens only flow via the secrets port. */
  readonly processEnv?: Record<string, string>;
  /** Value persisted under `GITHUB_TOKEN_STORAGE_KEY`, if any. */
  readonly secret?: string;
  /** Env the initialized platform reports through its secrets port. */
  readonly secretsEnv?: Record<string, string>;
}

async function installPlatformFor(
  { secret, secretsEnv }: TokenCase,
  storageKey: string,
): Promise<void> {
  await installPlatform({
    secrets: secret === undefined ? {} : { [storageKey]: secret },
    secretsEnv,
  });
}

function stubProcessEnv({ processEnv }: TokenCase): void {
  for (const [name, value] of Object.entries(processEnv ?? {})) {
    vi.stubEnv(name, value);
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('GITHUB_TOKEN', undefined);
  vi.stubEnv('GH_TOKEN', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getGitHubToken', () => {
  it.each<TokenCase & { expected: string }>([
    {
      name: 'prefers GH_TOKEN over GITHUB_TOKEN from the secrets env port',
      secretsEnv: {
        GITHUB_TOKEN: 'github-env-token',
        GH_TOKEN: 'gh-env-token',
      },
      expected: 'gh-env-token',
    },
    {
      name: 'ignores blank environment token values',
      secretsEnv: { GITHUB_TOKEN: '   ', GH_TOKEN: 'gh-env-token' },
      expected: 'gh-env-token',
    },
    {
      name: 'prefers the platform secret when the platform is initialized',
      processEnv: {
        GITHUB_TOKEN: 'github-env-token',
        GH_TOKEN: 'gh-env-token',
      },
      secret: 'gh-secret-token',
      expected: 'gh-secret-token',
    },
    {
      name: 'ignores blank platform secrets before using environment fallbacks',
      secret: '   ',
      secretsEnv: { GH_TOKEN: 'gh-env-token' },
      expected: 'gh-env-token',
    },
  ])('$name', async (tokenCase) => {
    stubProcessEnv(tokenCase);

    const githubAuth = await import('@tools/github/githubAuth');
    await installPlatformFor(tokenCase, githubAuth.GITHUB_TOKEN_STORAGE_KEY);

    await expect(githubAuth.getGitHubToken()).resolves.toBe(tokenCase.expected);
  });
});

describe('resolveGitHubTokenSource', () => {
  it.each<TokenCase & { expected: 'secret' | 'env' | 'none' }>([
    {
      name: 'reports "secret" when a persisted token exists, even with env vars set',
      secret: 'gh-secret-token',
      secretsEnv: {
        GH_TOKEN: 'gh-env-token',
        GITHUB_TOKEN: 'github-env-token',
      },
      expected: 'secret',
    },
    {
      name: 'reports "env" when no persisted token exists but an env var does',
      secretsEnv: { GH_TOKEN: 'gh-env-token' },
      expected: 'env',
    },
    {
      name: 'reports "none" when neither a persisted token nor an env var exists',
      expected: 'none',
    },
    {
      name: 'ignores a blank persisted token and falls back to an env var',
      secret: '   ',
      secretsEnv: { GH_TOKEN: 'gh-env-token' },
      expected: 'env',
    },
  ])('$name', async (tokenCase) => {
    const githubAuth = await import('@tools/github/githubAuth');
    await installPlatformFor(tokenCase, githubAuth.GITHUB_TOKEN_STORAGE_KEY);

    const { platform } = await import('@platform/platform');

    await expect(
      githubAuth.resolveGitHubTokenSource(platform().secrets),
    ).resolves.toBe(tokenCase.expected);
  });
});
