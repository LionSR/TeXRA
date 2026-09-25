/**
 * Host-neutral git reads behind the "recent commits" and environment-summary
 * surfaces the hosts render (the launcher's commit picker through the host
 * snapshot, the desktop workspace header). Previously implemented separately in
 * `packages/extension/src/commands/git/gitCommands.ts` and
 * `packages/desktop/src/main/desktopGitHost.ts`; this module is the single
 * owner.
 *
 * Every invocation goes through the shared command runner (no shell, no
 * string interpolation — the workspace path travels via `cwd`) with one
 * timeout/output policy, the shared `isGitRepository` probe, and the shared
 * `COMMIT_LABEL_FORMAT`, so all hosts produce byte-identical labels.
 *
 * Wiring stays with the callers: workspace-path resolution, the commit limit
 * (the `texra.git.numberOfCommitsToShow` setting for the launcher), and the
 * failure mapping.
 */

import { Effect } from 'effect';

import type { SettingsStores } from '@shared/config/settingsAccess';
import { executeCommand } from '@utils/system/execUtils';
import { isGitRepository } from '@utils/git/isGitRepository';

import { COMMIT_LABEL_FORMAT, splitCommitLines } from './commitLogFormat';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

/**
 * Hard upper bound on git output bytes (8 MiB). Commit subjects and numstat
 * totals comfortably fit inside the default 1 MiB; this is purely a guard
 * against pathological repos that could otherwise OOM the host process.
 */
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

const GIT_TIMEOUT_MS = 10_000;

export interface GitReadOptions {
  /**
   * Setting slots of the workspace being read, held as data by the host that
   * asked (its session roots): the spawned `git` carries that project's
   * configured identity rather than one resolved from ambient state.
   */
  settings: SettingsStores | undefined;
  /**
   * Hook for surfacing unexpected git failures (logging, telemetry). Probe
   * failures are never reported — a non-git workspace or a branch with no
   * upstream is steady state, not an error.
   */
  onError?: (error: unknown) => void;
}

/**
 * Run one git read, returning stdout (`''` when empty) or `undefined` on
 * failure. Failures go to `options.onError` unless `reportFailure` is false
 * (expected-failure probes such as `@{upstream}` on an unpublished branch).
 */
const readGit = Effect.fn('repositoryOverview.readGit')(function* (
  workspace: string,
  args: readonly string[],
  options: GitReadOptions,
  reportFailure = true,
): Effect.fn.Return<string | undefined, never, ChildProcessSpawner> {
  const result = yield* executeCommand(['git', ...args], {
    cwd: workspace,
    settings: options.settings,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    quiet: !reportFailure,
  });
  if (result.success) return result.stdout;
  if (reportFailure) {
    options.onError?.(
      new Error(
        result.stderr || `git ${args[0] ?? 'command'} exited unsuccessfully`,
      ),
    );
  }
  return undefined;
});

export interface GitRecentCommits {
  commits: string[];
  isGitRepo: boolean;
}

/**
 * Probing recent-commits read: up to `limit` labels (`<shortHash>: <subject>
 * (<relativeDate>)`), or `isGitRepo: false` when the workspace is not a
 * repository. A failed `git log` (also a zero-commit repo, where `log` exits
 * non-zero) answers `[]`: the probe already passed, so it is still a repo.
 */
export const readRecentCommits = Effect.fn(
  'repositoryOverview.readRecentCommits',
)(function* (
  workspacePath: string,
  limit: number,
  options: GitReadOptions,
): Effect.fn.Return<GitRecentCommits, never, ChildProcessSpawner> {
  if (!(yield* isGitRepository(workspacePath, options.settings))) {
    return { commits: [], isGitRepo: false };
  }
  const output = yield* readGit(
    workspacePath,
    [
      // `--no-pager` is portable; Windows lacks `cat` on PATH (#3817).
      '--no-pager',
      'log',
      '-n',
      String(limit),
      `--pretty=format:${COMMIT_LABEL_FORMAT}`,
    ],
    options,
  );
  return {
    commits: output === undefined ? [] : splitCommitLines(output),
    isGitRepo: true,
  };
});
