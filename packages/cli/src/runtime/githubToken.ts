import { platform } from '@platform/platform';
import {
  GITHUB_TOKEN_STORAGE_KEY,
  resolveGitHubTokenSource,
} from '@tools/github/githubAuth';
import { looksLikeCredentialPlaceholder } from './credentialInput';

export type GitHubTokenStatus = 'secret' | 'env' | 'none';

export function loadGitHubTokenStatus(): Promise<GitHubTokenStatus> {
  return resolveGitHubTokenSource(platform().secrets);
}

/** Persist a GitHub PAT without exposing it outside the credential store. */
export async function saveGitHubToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('GitHub token is empty.');
  if (looksLikeCredentialPlaceholder(trimmed, 'github')) {
    throw new Error(
      'This looks like a placeholder rather than a GitHub token. Enter a personal access token from GitHub.',
    );
  }
  await platform().secrets.set(GITHUB_TOKEN_STORAGE_KEY, trimmed);
}

export async function removeGitHubToken(): Promise<void> {
  await platform().secrets.delete(GITHUB_TOKEN_STORAGE_KEY);
}
