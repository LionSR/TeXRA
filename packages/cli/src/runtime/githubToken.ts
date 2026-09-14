import { Effect } from 'effect';

import { storeCredential } from '@common/secrets/storeCredential';
import type { PlatformSecrets, SecretsFailed } from '@platform/secrets';
import { GITHUB_TOKEN_STORAGE_KEY } from '@tools/github/githubAuth';

export type GitHubTokenStatus = 'secret' | 'env' | 'none';

/**
 * Persist a GitHub PAT without exposing it outside the credential store. The
 * credential store is Effect-typed, so this is a program the terminal surface
 * settles on the process runtime it already holds.
 */
export function saveGitHubToken(
  secrets: PlatformSecrets,
  token: string,
): Effect.Effect<void, Error | SecretsFailed> {
  return storeCredential(secrets, {
    secretName: GITHUB_TOKEN_STORAGE_KEY,
    value: token,
    kind: 'github',
  });
}

export function removeGitHubToken(
  secrets: PlatformSecrets,
): Effect.Effect<void, SecretsFailed> {
  return secrets.delete(GITHUB_TOKEN_STORAGE_KEY);
}
