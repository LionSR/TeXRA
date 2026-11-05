/**
 * The host-neutral `git` reads about a folder: its repository root, origin
 * URL, current branch and origin's default branch. Each answers `null` when
 * `git` cannot say (no repository, no origin, detached HEAD), so a failed
 * probe is an ordinary answer, not an error, and is not logged. `settings`
 * carries the slots the spawn's git identity is read from; a caller with none
 * passes `undefined` and gets the user's own identity. Whether a folder is a
 * working tree at all is `isGitRepository`.
 */

import { Effect } from 'effect';

import { executeCommand } from '@texra-ai/harness/node';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import type { SettingsStores } from '@texra-ai/harness/host';

type GitRead = Effect.Effect<string | null, never, ChildProcessSpawner>;

/** The trimmed stdout of a successful `git` run, or null. */
function gitValue(
  cwd: string,
  settings: SettingsStores | undefined,
  ...args: readonly string[]
): GitRead {
  return Effect.map(
    executeCommand(['git', ...args], { cwd, settings, quiet: true }),
    (result) => (result.success && result.stdout ? result.stdout.trim() : null),
  );
}

export function repositoryRoot(
  cwd: string,
  settings: SettingsStores | undefined,
): GitRead {
  return gitValue(cwd, settings, 'rev-parse', '--show-toplevel');
}

export function originUrl(
  cwd: string,
  settings: SettingsStores | undefined,
): GitRead {
  return gitValue(cwd, settings, 'remote', 'get-url', 'origin');
}

/** The checked-out branch; null on a detached HEAD. */
export function currentBranch(
  cwd: string,
  settings: SettingsStores | undefined,
): GitRead {
  return Effect.map(
    gitValue(cwd, settings, 'rev-parse', '--abbrev-ref', 'HEAD'),
    (branch) => (branch === 'HEAD' ? null : branch),
  );
}

/** The branch `origin/HEAD` points at, e.g. "main". */
export function originDefaultBranch(
  cwd: string,
  settings: SettingsStores | undefined,
): GitRead {
  return Effect.map(
    gitValue(
      cwd,
      settings,
      'symbolic-ref',
      '--short',
      'refs/remotes/origin/HEAD',
    ),
    (ref) => (ref?.startsWith('origin/') ? ref.slice('origin/'.length) : ref),
  );
}
