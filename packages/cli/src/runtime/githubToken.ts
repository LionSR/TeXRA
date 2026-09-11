import { storeCredential } from '@common/secrets/storeCredential';
import type { PlatformSecrets } from '@platform/secrets';
import {
  GITHUB_TOKEN_STORAGE_KEY,
  resolveGitHubTokenSource,
} from '@tools/github/githubAuth';

export type GitHubTokenStatus = 'secret' | 'env' | 'none';

export function loadGitHubTokenStatus(
  secrets: PlatformSecrets,
): Promise<GitHubTokenStatus> {
  return resolveGitHubTokenSource(secrets);
}

/** Persist a GitHub PAT without exposing it outside the credential store. */
export function saveGitHubToken(
  secrets: PlatformSecrets,
  token: string,
): Promise<void> {
  return storeCredential(secrets, {
    secretName: GITHUB_TOKEN_STORAGE_KEY,
    value: token,
    kind: 'github',
  });
}

export function removeGitHubToken(secrets: PlatformSecrets): Promise<void> {
  return secrets.delete(GITHUB_TOKEN_STORAGE_KEY);
}
