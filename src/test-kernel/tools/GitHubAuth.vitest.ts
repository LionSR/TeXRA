import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { FakeSecrets } from '@test/support/FakePlatform';
import { withEnv } from '@test/support/testEnv';
import {
  getGitHubToken,
  GITHUB_TOKEN_STORAGE_KEY,
} from '@texra/tools/github/githubAuth';

describe('getGitHubToken', () => {
  it.effect.each<{
    readonly name: string;
    readonly secret?: string;
    readonly env: Record<string, string>;
    readonly expected: string;
  }>([
    {
      name: 'prefers GH_TOKEN over GITHUB_TOKEN from the environment',
      env: { GITHUB_TOKEN: 'github-env-token', GH_TOKEN: 'gh-env-token' },
      expected: 'gh-env-token',
    },
    {
      name: 'prefers the persisted secret over environment fallbacks',
      env: { GITHUB_TOKEN: 'github-env-token', GH_TOKEN: 'gh-env-token' },
      secret: 'gh-secret-token',
      expected: 'gh-secret-token',
    },
    {
      name: 'ignores blank platform secrets before using environment fallbacks',
      secret: '   ',
      env: { GH_TOKEN: 'gh-env-token' },
      expected: 'gh-env-token',
    },
  ])('$name', ({ secret, env, expected }) =>
    Effect.gen(function* () {
      const secrets = new FakeSecrets(
        secret === undefined ? {} : { [GITHUB_TOKEN_STORAGE_KEY]: secret },
      );
      expect(yield* getGitHubToken(secrets)).toBe(expected);
    }).pipe(withEnv(env)),
  );
});
