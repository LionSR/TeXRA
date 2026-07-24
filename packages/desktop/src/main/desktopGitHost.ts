/**
 * Desktop git host — closes audit item A from
 * `docs/dev/audits/2026-05-08-standalone-trajectory-audit.md` (trajectory #16).
 *
 * The VS Code extension surfaces "recent commits" via `texra.getRecentCommits`,
 * which shells out to `git log` with the shared `COMMIT_LABEL_FORMAT` and
 * returns the lines verbatim. The desktop shell historically replied to
 * `MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS` with an empty list because no
 * `vscode.git`-equivalent host port existed. This module fills that gap by
 * spawning `git log` directly via Node's `child_process.execFile` (no shell,
 * no string interpolation — the workspace path travels via `cwd`), reusing
 * the same host-neutral `isGitRepository` probe and label format the
 * extension uses so the two hosts can't drift apart.
 */

// Not routed through executeCommand: it doesn't expose a `maxBuffer` option,
// and the explicit MAX_BUFFER_BYTES cap below is a deliberate Electron
// main-process OOM guard (execa's own default maxBuffer is ~100 MiB).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { clamp } from '@utils/core';
import {
  COMMIT_LABEL_FORMAT,
  splitCommitLines,
} from '@utils/git/commitLogFormat';
import { isGitRepository } from '@utils/system/isGitRepository';
import { extendEnvPath } from '@utils/system/platformPaths';

const execFileAsync = promisify(execFile);

/**
 * Maximum number of commits the renderer will display in the launcher banner.
 * Mirrors the extension's `texra.git.numberOfCommitsToShow` default (20). The
 * desktop currently has no per-user override; if/when one is wired the cap
 * stays here as a defence-in-depth bound.
 */
const DEFAULT_COMMIT_LIMIT = 20;
const MAX_COMMIT_LIMIT = 1000;

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
  /**
   * Hard cap on the number of commits returned. Defaults to 20 to match
   * `texra.git.numberOfCommitsToShow`.
   */
  commitLimit?: number;
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
  const limit = clampCommitLimit(options.commitLimit ?? DEFAULT_COMMIT_LIMIT);

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

      try {
        const { stdout } = await execFileAsync(
          'git',
          [
            // `--no-pager` is portable; Windows lacks `cat` on PATH (#3817).
            '--no-pager',
            'log',
            '-n',
            String(limit),
            `--pretty=format:${COMMIT_LABEL_FORMAT}`,
          ],
          {
            cwd: workspace,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: MAX_BUFFER_BYTES,
            // Same extended PATH as the shared isGitRepository probe, so the
            // gate can't report a repo the log call then fails to read.
            env: { ...process.env, PATH: extendEnvPath() },
          },
        );
        return {
          commits: splitCommitLines(stdout),
          isGitRepo: true,
        };
      } catch (error) {
        // rev-parse already passed, so we know it's a repo — report
        // isGitRepo:true with an empty list so empty-repo states stay honest.
        options.onError?.(error);
        return { commits: [], isGitRepo: true };
      }
    },
  };
}

function clampCommitLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_COMMIT_LIMIT;
  const rounded = Math.floor(value);
  if (rounded <= 0) return DEFAULT_COMMIT_LIMIT;
  return clamp(rounded, 1, MAX_COMMIT_LIMIT);
}
