// Thin wrappers over `git` and `gh` for the `install-github-action` command's
// writes and its `gh` check. The repository reads are the harness's
// (`@texra-ai/worldline/node`). Every call captures output and never fails —
// callers branch on `success`.
//
// These commands carry no TeXRA settings, so they use the user's Git identity.
import { Effect } from 'effect';

import { executeCommand, type ExecResult } from '@texra-ai/worldline/node';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

type GitRead<A> = Effect.Effect<A, never, ChildProcessSpawner>;

export function git(
  cwd: string,
  ...args: readonly string[]
): GitRead<ExecResult> {
  return executeCommand(['git', ...args], {
    cwd,
    quiet: true,
  });
}

export function gh(
  cwd: string,
  ...args: readonly string[]
): GitRead<ExecResult> {
  return executeCommand(['gh', ...args], {
    cwd,
    quiet: true,
  });
}

export function ghAvailable(cwd: string): GitRead<boolean> {
  return Effect.map(gh(cwd, '--version'), (result) => result.success);
}
