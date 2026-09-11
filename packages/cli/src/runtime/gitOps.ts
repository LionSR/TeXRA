// Thin wrappers over `git` and `gh` for the `install-github-action` command.
// Every call captures output and never throws — callers branch on `success`.
import type { ExecResult } from '@shared/schemas';
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
