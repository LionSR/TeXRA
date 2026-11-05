// Thin wrappers over `git` and `gh` for the `install-github-action` command's
// writes and its two command-specific checks. The repository reads it shares
// with the app (work tree, root, origin, branches) are
// `@texra/utils/git/gitReads`. Every call captures output and never fails —
// callers branch on `success`.
//
// These commands carry no TeXRA settings, so they use the user's Git identity.
import { Effect } from 'effect';

import { executeCommand, type ExecResult } from '@texra-ai/harness/node';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

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
