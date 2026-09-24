/**
 * Host-neutral git reads behind the "recent commits" and environment-summary
 * surfaces the hosts render (VS Code `texra.getRecentCommits`, desktop
 * launcher banner / workspace header). Previously implemented separately in
 * `packages/extension/src/commands/git/gitCommands.ts` and
 * `packages/desktop/src/main/desktopGitHost.ts`; this module is the single
 * owner.
 *
 * Every invocation goes through the shared command runner (no shell, no
 * string interpolation — the workspace path travels via `cwd`) with one
 * timeout/output policy, the shared `isGitRepository` probe, and the shared
 * `COMMIT_LABEL_FORMAT`, so all hosts produce byte-identical labels.
 *
 * Wiring stays in the hosts: workspace-path resolution, the commit limit
 * (extension setting vs desktop constant), and the per-host failure mapping
 * (`null` vs `{ commits: [], isGitRepo }` vs the wire-schema constant).
 */

import { Effect } from 'effect';

import type { SettingsStores } from '@shared/config/settingsAccess';
import { executeCommand } from '@utils/system/execUtils';
import { isGitRepository } from '@utils/git/isGitRepository';

import { COMMIT_LABEL_FORMAT, splitCommitLines } from './commitLogFormat';

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
): Effect.fn.Return<string | undefined> {
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
 * Read up to `limit` recent commit labels (`<shortHash>: <subject>
 * (<relativeDate>)`) from an already-probed repository. Returns `undefined`
 * when `git log` itself fails (also on a zero-commit repo, where `log`
 * exits non-zero); callers map that to their host's empty-result convention.
 *
 * Callers own the repository probe so host policy can sit between probe and
 * read (the extension validates its commit-limit setting in between); hosts
 * without such policy should use `readRecentCommits` instead.
 */
export const readRecentCommitLabels = Effect.fn(
  'repositoryOverview.readRecentCommitLabels',
)(function* (
  workspacePath: string,
  limit: number,
  options: GitReadOptions,
): Effect.fn.Return<string[] | undefined> {
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
  return output === undefined ? undefined : splitCommitLines(output);
});

/**
 * Probing recent-commits read: reports `isGitRepo: false` when the workspace
 * is not a repository, otherwise the labels (`[]` when the log read fails —
 * the probe already passed, so a failed log is still a git repo).
 */
export const readRecentCommits = Effect.fn(
  'repositoryOverview.readRecentCommits',
)(function* (
  workspacePath: string,
  limit: number,
  options: GitReadOptions,
): Effect.fn.Return<GitRecentCommits> {
  if (!(yield* isGitRepository(workspacePath, options.settings))) {
    return { commits: [], isGitRepo: false };
  }
  const commits = yield* readRecentCommitLabels(workspacePath, limit, options);
  return { commits: commits ?? [], isGitRepo: true };
});
