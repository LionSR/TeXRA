import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { FakeSecrets } from '@test/support/FakePlatform';
import { withEnv } from '@test/support/testEnv';
import {
  getGitHubToken,
  GITHUB_TOKEN_STORAGE_KEY,
  resolveGitHubTokenSource,
} from '@tools/github/githubAuth';

/** Secret/env fixture for one row of a token-precedence table. */
interface TokenCase {
  readonly name: string;
  /** Value persisted under `GITHUB_TOKEN_STORAGE_KEY`, if any. */
  readonly secret?: string;
  /** The process environment the case's ConfigProvider serves. */
  readonly env?: Record<string, string>;
}

/** The case's secret store as the port both readers take: secrets only. */
function secretsFor({ secret }: TokenCase): FakeSecrets {
  return new FakeSecrets(
    secret === undefined ? {} : { [GITHUB_TOKEN_STORAGE_KEY]: secret },
  );
}

describe('getGitHubToken', () => {
  it.effect.each<TokenCase & { expected: string }>([
    {
      name: 'prefers GH_TOKEN over GITHUB_TOKEN from the environment',
      env: {
        GITHUB_TOKEN: 'github-env-token',
        GH_TOKEN: 'gh-env-token',
      },
      expected: 'gh-env-token',
    },
    {
      name: 'ignores blank environment token values',
      env: { GITHUB_TOKEN: '   ', GH_TOKEN: 'gh-env-token' },
      expected: 'gh-env-token',
    },
    {
      name: 'prefers the persisted secret over environment fallbacks',
      env: {
        GITHUB_TOKEN: 'github-env-token',
        GH_TOKEN: 'gh-env-token',
      },
      secret: 'gh-secret-token',
      expected: 'gh-secret-token',
    },
    {
      name: 'ignores blank platform secrets before using environment fallbacks',
      secret: '   ',
      env: { GH_TOKEN: 'gh-env-token' },
      expected: 'gh-env-token',
    },
  ])('$name', (tokenCase) =>
    Effect.gen(function* () {
      expect(yield* getGitHubToken(secretsFor(tokenCase))).toBe(
        tokenCase.expected,
      );
    }).pipe(withEnv(tokenCase.env ?? {})),
  );
});

describe('resolveGitHubTokenSource', () => {
  it.effect.each<TokenCase & { expected: 'secret' | 'env' | 'none' }>([
    {
      name: 'reports "secret" when a persisted token exists, even with env vars set',
      secret: 'gh-secret-token',
      env: {
        GH_TOKEN: 'gh-env-token',
        GITHUB_TOKEN: 'github-env-token',
      },
      expected: 'secret',
    },
    {
      name: 'reports "env" when no persisted token exists but an env var does',
      env: { GH_TOKEN: 'gh-env-token' },
      expected: 'env',
    },
    {
      name: 'reports "none" when neither a persisted token nor an env var exists',
      expected: 'none',
    },
    {
      name: 'ignores a blank persisted token and falls back to an env var',
      secret: '   ',
      env: { GH_TOKEN: 'gh-env-token' },
      expected: 'env',
    },
  ])('$name', (tokenCase) =>
    Effect.gen(function* () {
      expect(yield* resolveGitHubTokenSource(secretsFor(tokenCase))).toBe(
        tokenCase.expected,
      );
    }).pipe(withEnv(tokenCase.env ?? {})),
  );
});
