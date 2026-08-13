// Thin wrappers over `git` and `gh` for the `install-github-action` command.
// Every call captures output and never throws — callers branch on `success`.
import type { ExecResult } from '@shared/schemas/opResults';
import { executeCommandSync } from '@utils/system/execUtils';

export function git(cwd: string, ...args: readonly string[]): ExecResult {
  return executeCommandSync(['git', ...args], { cwd, quiet: true });
}

export function gh(cwd: string, ...args: readonly string[]): ExecResult {
  return executeCommandSync(['gh', ...args], { cwd, quiet: true });
}

export function isGitRepo(cwd: string): boolean {
  return git(cwd, 'rev-parse', '--is-inside-work-tree').success;
}

export function repoRoot(cwd: string): string | null {
  const result = git(cwd, 'rev-parse', '--show-toplevel');
  return result.success && result.stdout ? result.stdout : null;
}

export function remoteUrl(cwd: string, remote = 'origin'): string | null {
  const result = git(cwd, 'remote', 'get-url', remote);
  return result.success && result.stdout ? result.stdout : null;
}

export function currentBranch(cwd: string): string | null {
  const result = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (!result.success || !result.stdout || result.stdout === 'HEAD') {
    return null;
  }
  return result.stdout;
}

/** Default branch of `origin`, e.g. "main" — null if it can't be resolved. */
export function defaultBranch(cwd: string): string | null {
  const result = git(
    cwd,
    'symbolic-ref',
    '--short',
    'refs/remotes/origin/HEAD',
  );
  if (!result.success || !result.stdout) return null;
  return result.stdout.startsWith('origin/')
    ? result.stdout.slice('origin/'.length)
    : result.stdout;
}

export function localBranchExists(cwd: string, branch: string): boolean {
  return git(cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)
    .success;
}

export function ghAvailable(cwd: string): boolean {
  return gh(cwd, '--version').success;
}

export interface GitHubSlug {
  readonly owner: string;
  readonly repo: string;
}

/** Parse `owner/repo` from an https or ssh GitHub remote URL. */
export function parseGitHubSlug(url: string): GitHubSlug | null {
  const cleaned = url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  const match = cleaned.match(/github\.com[/:]([^/]+)\/([^/]+)$/);
  if (!match) return null;
  const [, owner, repo] = match;
  if (!owner || !repo) return null;
  return { owner, repo };
}
