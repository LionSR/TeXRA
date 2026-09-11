import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSecrets } from '@test/support/FakePlatform';
import {
  getGitHubToken,
  GITHUB_TOKEN_STORAGE_KEY,
  resolveGitHubTokenSource,
} from '@tools/github/githubAuth';

/** Secret/env fixture for one row of a token-precedence table. */
interface TokenCase {
  readonly name: string;
  /** Real process env, stubbed to prove tokens only flow via the secrets port. */
  readonly processEnv?: Record<string, string>;
  /** Value persisted under `GITHUB_TOKEN_STORAGE_KEY`, if any. */
  readonly secret?: string;
  /** Env the secret store reports through its `getEnv` member. */
  readonly secretsEnv?: Record<string, string>;
}

/**
 * The case's secret store as the port both readers take: the token flows
 * through this object alone, never through `process.env`.
 */
function secretsFor({ secret, secretsEnv }: TokenCase): FakeSecrets {
  return new FakeSecrets(
    secret === undefined ? {} : { [GITHUB_TOKEN_STORAGE_KEY]: secret },
    secretsEnv ?? {},
  );
}

function stubProcessEnv({ processEnv }: TokenCase): void {
  for (const [name, value] of Object.entries(processEnv ?? {})) {
    vi.stubEnv(name, value);
  }
}

beforeEach(() => {
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
      name: 'prefers the persisted secret over environment fallbacks',
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

    await expect(getGitHubToken(secretsFor(tokenCase))).resolves.toBe(
      tokenCase.expected,
    );
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
    await expect(resolveGitHubTokenSource(secretsFor(tokenCase))).resolves.toBe(
      tokenCase.expected,
    );
  });
});
