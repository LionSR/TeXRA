/**
 * Desktop git host — closes audit item A from
 * `docs/dev/audits/2026-05-08-standalone-trajectory-audit.md` (trajectory #16).
 *
 * The VS Code extension surfaces "recent commits" via `texra.getRecentCommits`,
 * which shells out to `git log` with the shared `COMMIT_LABEL_FORMAT` and
 * returns the lines verbatim. The desktop shell historically replied to
 * `MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS` with an empty list because no
 * `vscode.git`-equivalent host port existed. This module fills that gap by
 * invoking `git log` through the shared command runner (no shell, no string
 * interpolation — the workspace path travels via `cwd`), reusing the same
 * host-neutral process policy, repository probe, and label format as the
 * extension.
 */

import {
  COMMIT_LABEL_FORMAT,
  splitCommitLines,
} from '@utils/git/commitLogFormat';
import { isGitRepository } from '@utils/system/isGitRepository';
import { executeCommand } from '@utils/system/execUtils';

import {
  EMPTY_DESKTOP_ENVIRONMENT_SUMMARY,
  type DesktopEnvironmentSummary,
} from '../shared/desktopWorkspaceMessages.js';

/**
 * Maximum number of commits the renderer will display in the launcher banner.
 * Mirrors the extension's `texra.git.numberOfCommitsToShow` default (20). The
 * desktop has no per-user override.
 */
const COMMIT_LIMIT = 20;

/**
 * Hard upper bound on git output bytes (8 MiB). 20 commits with subjects
 * comfortably fits inside the default 1 MiB; this is purely a guard against
 * pathological repos that could otherwise OOM the main process.
 */
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

const GIT_TIMEOUT_MS = 10_000;

export interface DesktopGitHost {
  /**
   * Returns the most recent commits in the workspace, formatted as
   * `<shortHash>: <subject> (<relativeDate>)`. The boolean reports whether
   * the workspace looked like a git repo at probe time. Both the array and
   * the boolean are answered conservatively when probing fails.
   */
  getRecentCommits(): Promise<DesktopGitCommitsResult>;
  /** Returns the live local branch, change totals, and upstream sync state. */
  getEnvironmentSummary(): Promise<DesktopEnvironmentSummary>;
}

interface DesktopGitCommitsResult {
  commits: string[];
  isGitRepo: boolean;
}

export interface CreateDesktopGitHostOptions {
  /**
   * Resolves the workspace path at call time. Pulled lazily so the host
   * picks up workspace switches without needing to be re-instantiated.
   */
  getWorkspacePath: () => string | undefined;
  /** Hook for surfacing unexpected errors (logging, telemetry). */
  onError?: (error: unknown) => void;
}

/**
 * Build a desktop git host backed by `git log` via `child_process.execFile`.
 *
 * The host is intentionally stateless — each call re-probes the workspace so
 * callers don't have to invalidate caches when the user switches folders.
 * The launcher banner only fires on `REQUEST_RECENT_COMMITS`, so the cost of
 * a fresh `git log` per request is negligible compared with caching
 * complexity.
 */
export function createDesktopGitHost(
  options: CreateDesktopGitHostOptions,
): DesktopGitHost {
  async function readGit(
    workspace: string,
    args: readonly string[],
    reportFailure = true,
  ): Promise<string | undefined> {
    const result = await executeCommand(['git', ...args], {
      cwd: workspace,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      quiet: !reportFailure,
    });
    if (result.success) return result.stdout ?? '';
    if (reportFailure) {
      options.onError?.(
        new Error(
          result.stderr ?? `git ${args[0] ?? 'command'} exited unsuccessfully`,
        ),
      );
    }
    return undefined;
  }

  return {
    async getRecentCommits(): Promise<DesktopGitCommitsResult> {
      const workspace = options.getWorkspacePath();
      if (!workspace) {
        return { commits: [], isGitRepo: false };
      }
      // Uses `git rev-parse --is-inside-work-tree` instead of
      // `existsSync('.git')` — the latter wrongly reports `false` from
      // subdirectories and misses worktrees/submodules where `.git` is a
      // pointer file (bot review #3817). This shared probe times out at 5s
      // (this file previously inlined its own 10s timeout) — intentional:
      // 5s is still generous for a `rev-parse` round-trip, and using the
      // same probe as every other host caller matters more than the extra
      // slack.
      if (!(await isGitRepository(workspace))) {
        // Missing git, not a repo, etc. Don't surface via `onError` — this
        // is the steady-state for any non-git workspace.
        return { commits: [], isGitRepo: false };
      }

      const output = await readGit(workspace, [
        // `--no-pager` is portable; Windows lacks `cat` on PATH (#3817).
        '--no-pager',
        'log',
        '-n',
        String(COMMIT_LIMIT),
        `--pretty=format:${COMMIT_LABEL_FORMAT}`,
      ]);
      // rev-parse already passed, so a failed log is still a git repo. The
      // shared runner reports the failure through onError above.
      return {
        commits: output === undefined ? [] : splitCommitLines(output),
        isGitRepo: true,
      };
    },
    async getEnvironmentSummary(): Promise<DesktopEnvironmentSummary> {
      const workspace = options.getWorkspacePath();
      if (!workspace || !(await isGitRepository(workspace))) {
        return EMPTY_DESKTOP_ENVIRONMENT_SUMMARY;
      }

      const [branchOutput, statusOutput, numstatOutput, upstreamOutput] =
        await Promise.all([
          readGit(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']),
          readGit(workspace, ['status', '--short', '--untracked-files=normal']),
          readGit(workspace, ['diff', '--numstat', 'HEAD', '--']),
          readGit(
            workspace,
            [
              'rev-parse',
              '--abbrev-ref',
              '--symbolic-full-name',
              '@{upstream}',
            ],
            false,
          ),
        ]);
      const { additions, deletions } = parseNumstat(numstatOutput);
      const changedFiles = splitNonEmptyLines(statusOutput).length;
      const branch =
        branchOutput && branchOutput !== 'HEAD' ? branchOutput : undefined;
      const upstream = upstreamOutput || undefined;
      let ahead = 0;
      let behind = 0;

      if (upstream) {
        const divergence = await readGit(workspace, [
          'rev-list',
          '--left-right',
          '--count',
          `HEAD...${upstream}`,
        ]);
        [ahead, behind] = parseDivergence(divergence);
      }

      return {
        isGitRepository: true,
        ...(branch ? { branch } : {}),
        ...(upstream ? { upstream } : {}),
        changedFiles,
        additions,
        deletions,
        ahead,
        behind,
      };
    },
  };
}

function splitNonEmptyLines(output: string | undefined): string[] {
  return output?.split(/\r?\n/).filter(Boolean) ?? [];
}

function parseNumstat(output: string | undefined): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of splitNonEmptyLines(output)) {
    const [added = '', deleted = ''] = line.split('\t');
    additions += parseGitCount(added);
    deletions += parseGitCount(deleted);
  }
  return { additions, deletions };
}

function parseDivergence(output: string | undefined): [number, number] {
  const [ahead = '', behind = ''] = output?.split(/\s+/) ?? [];
  return [parseGitCount(ahead), parseGitCount(behind)];
}

function parseGitCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
