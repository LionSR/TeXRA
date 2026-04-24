/**
 * Injectable GitHub token provider.
 *
 * This module is VS Code-free. The extension host registers an implementation
 * during activation (see `setGitHubTokenProvider`) that reads from VS Code's
 * SecretStorage (or `GITHUB_TOKEN` env fallback). Tools and the polling
 * service read the token lazily via `getGitHubToken()` so they never depend on
 * VS Code APIs directly.
 */

export type GitHubTokenProvider = () => string | undefined;

let provider: GitHubTokenProvider = () => undefined;

export function setGitHubTokenProvider(p: GitHubTokenProvider): void {
  provider = p;
}

export function getGitHubToken(): string | undefined {
  const token = provider();
  return token && token.length > 0 ? token : undefined;
}
