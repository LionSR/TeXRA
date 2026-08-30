import { storeCredential } from '@common/secrets/storeCredential';
import { platform } from '@platform/platform';
import {
  GITHUB_TOKEN_STORAGE_KEY,
  resolveGitHubTokenSource,
} from '@tools/github/githubAuth';

export type GitHubTokenStatus = 'secret' | 'env' | 'none';

export function loadGitHubTokenStatus(): Promise<GitHubTokenStatus> {
  return resolveGitHubTokenSource(platform().secrets);
}

/** Persist a GitHub PAT without exposing it outside the credential store. */
export async function saveGitHubToken(token: string): Promise<void> {
  await storeCredential(platform().secrets, {
    secretName: GITHUB_TOKEN_STORAGE_KEY,
    value: token,
    kind: 'github',
  });
}

export async function removeGitHubToken(): Promise<void> {
  await platform().secrets.delete(GITHUB_TOKEN_STORAGE_KEY);
}
