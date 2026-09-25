// Thin wrappers over `git` and `gh` for the `install-github-action` command.
// Every call captures output and never fails — callers branch on `success`.
//
// These commands carry no TeXRA settings, so they use the user's Git identity.
import { Effect } from 'effect';

import type { ExecResult } from '@shared/schemas';
import { executeCommand } from '@utils/system/execUtils';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

type GitRead<A> = Effect.Effect<A, never, ChildProcessSpawner>;

export function git(
  cwd: string,
  ...args: readonly string[]
): GitRead<ExecResult> {
  return executeCommand(['git', ...args], {
    cwd,
    settings: undefined,
    quiet: true,
  });
}

export function gh(
  cwd: string,
  ...args: readonly string[]
): GitRead<ExecResult> {
  return executeCommand(['gh', ...args], {
    cwd,
    settings: undefined,
    quiet: true,
  });
}

/** The trimmed stdout of a successful `git` read, or null. */
function gitValue(
  cwd: string,
  ...args: readonly string[]
): GitRead<string | null> {
  return Effect.map(git(cwd, ...args), (result) =>
    result.success && result.stdout ? result.stdout : null,
  );
}

export function isGitRepo(cwd: string): GitRead<boolean> {
  return Effect.map(
    git(cwd, 'rev-parse', '--is-inside-work-tree'),
    (result) => result.success,
  );
}

export function repoRoot(cwd: string): GitRead<string | null> {
  return gitValue(cwd, 'rev-parse', '--show-toplevel');
}

export function remoteUrl(
  cwd: string,
  remote = 'origin',
): GitRead<string | null> {
  return gitValue(cwd, 'remote', 'get-url', remote);
}

export function currentBranch(cwd: string): GitRead<string | null> {
  return Effect.map(
    gitValue(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'),
    (branch) => (branch === 'HEAD' ? null : branch),
  );
}

/** Default branch of `origin`, e.g. "main" — null if it can't be resolved. */
export function defaultBranch(cwd: string): GitRead<string | null> {
  return Effect.map(
    gitValue(cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'),
    (ref) =>
      ref !== null && ref.startsWith('origin/')
        ? ref.slice('origin/'.length)
        : ref,
  );
}

export function localBranchExists(
  cwd: string,
  branch: string,
): GitRead<boolean> {
  return Effect.map(
    git(cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`),
    (result) => result.success,
  );
}

export function ghAvailable(cwd: string): GitRead<boolean> {
  return Effect.map(gh(cwd, '--version'), (result) => result.success);
}
