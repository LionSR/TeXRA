/** A GitHub repository named by owner and repository name. */
export interface GitHubSlug {
  readonly owner: string;
  readonly repo: string;
}

/**
 * Parse `owner/repo` from a GitHub remote URL: `https://github.com/o/r`,
 * `git@github.com:o/r` or `ssh://git@github.com/o/r`, each with or without
 * `.git` and a trailing slash. Repository names may contain dots
 * (`org.github.io`). Any other host yields null.
 */
export function parseGitHubSlug(url: string): GitHubSlug | null {
  const cleaned = url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  const match = cleaned.match(
    /^(?:https?:\/\/(?:[^@/]+@)?(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/)([^/]+)\/([^/]+)$/,
  );
  if (!match) return null;
  const [, owner, repo] = match;
  return owner && repo ? { owner, repo } : null;
}
