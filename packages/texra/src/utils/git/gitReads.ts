/**
 * The host-neutral reads of a repository's identity: is this a work tree,
 * its root, its origin URL, its current branch and origin's default branch.
 * Every host and tool that asks one of these questions asks it here, so a
 * fix (a timeout, the git identity from `settings`) is made once.
 *
 * Each read never fails: a failed `git` answers `false` or `null`, and the
 * caller says what that means for its own task. Interrupting the calling
 * fiber kills the `git` process instead of abandoning it; `executeCommand`
 * owns that teardown.
 *
 * VS Code-free, and they read no ambient state: `cwd` is the folder to read
 * and `settings` the slots the spawn's git identity is read from, both carried
 * as data by whoever holds them (a session's roots, a tool call's settings;
 * `undefined` for a command run outside any session, which then uses the
 * user's own git identity).
 */

import { Effect } from 'effect';

import { executeCommand } from '@texra-ai/harness/node';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import type { SettingsStores } from '@texra-ai/harness/host';

type GitRead<A> = Effect.Effect<A, never, ChildProcessSpawner>;

const GIT_READ_TIMEOUT_MS = 10_000;

/** The trimmed stdout of a successful, non-empty `git` read, or null. */
function gitValue(
  cwd: string,
  settings: SettingsStores | undefined,
  ...args: readonly string[]
): GitRead<string | null> {
  return executeCommand(['git', ...args], {
    cwd,
    settings,
    timeout: GIT_READ_TIMEOUT_MS,
    quiet: true,
  }).pipe(
    Effect.map((result) => {
      const value = result.stdout.trim();
      return result.success && value !== '' ? value : null;
    }),
  );
}

/**
 * Whether `cwd` is inside a git work tree. A bare repository and the inside
 * of `.git` are not: nothing there can be checked out or written to.
 * `undefined` means "no folder", which is not a repository.
 */
export function isGitRepository(
  cwd: string | undefined,
  settings: SettingsStores | undefined,
): GitRead<boolean> {
  if (!cwd) return Effect.succeed(false);
  return Effect.map(
    gitValue(cwd, settings, 'rev-parse', '--is-inside-work-tree'),
    (value) => value === 'true',
  );
}

/** The top-level directory of the work tree holding `cwd`, or null. */
export function repositoryRoot(
  cwd: string,
  settings: SettingsStores | undefined,
): GitRead<string | null> {
  return gitValue(cwd, settings, 'rev-parse', '--show-toplevel');
}

/** The URL of the `origin` remote, or null when there is none. */
export function originUrl(
  cwd: string,
  settings: SettingsStores | undefined,
): GitRead<string | null> {
  return gitValue(cwd, settings, 'remote', 'get-url', 'origin');
}

/** The checked-out branch, or null when HEAD is detached or unreadable. */
export function currentBranch(
  cwd: string,
  settings: SettingsStores | undefined,
): GitRead<string | null> {
  return Effect.map(
    gitValue(cwd, settings, 'rev-parse', '--abbrev-ref', 'HEAD'),
    (branch) => (branch === 'HEAD' ? null : branch),
  );
}

/**
 * The default branch `origin/HEAD` points at (`main` for `origin/main`), or
 * null when the clone has no such ref.
 */
export function originDefaultBranch(
  cwd: string,
  settings: SettingsStores | undefined,
): GitRead<string | null> {
  return Effect.map(
    gitValue(
      cwd,
      settings,
      'symbolic-ref',
      '--short',
      'refs/remotes/origin/HEAD',
    ),
    (ref) =>
      ref?.startsWith('origin/') && ref.length > 'origin/'.length
        ? ref.slice('origin/'.length)
        : null,
  );
}
