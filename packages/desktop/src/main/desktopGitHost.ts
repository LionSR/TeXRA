/**
 * Desktop git host — closes audit item A from
 * `docs/dev/standalone-trajectory-audit.md` (trajectory #16).
 *
 * The VS Code extension surfaces "recent commits" via `texra.getRecentCommits`,
 * which shells out to `git log` with `--pretty=format:'%h: %s (%cr)'` and
 * returns the lines verbatim. The desktop shell historically replied to
 * `MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS` with an empty list because no
 * `vscode.git`-equivalent host port existed. This module fills that gap by
 * spawning `git log` directly via Node's `child_process.execFile` (no shell,
 * no string interpolation — the workspace path travels via `cwd`).
 *
 * The renderer's `SetRecentCommitsMessageSchema` consumes a `string[]` of
 * pre-formatted labels, so we parse a richer tab-separated `--pretty=format`
 * payload (`%h%x09%s%x09%cr`) and rebuild the same `<short>: <subject>
 * (<relative>)` shape the extension produces. Splitting the format keeps the
 * parser robust against subjects that contain `: ` literally — those would
 * have been ambiguous if we'd echoed the human-readable label directly.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Maximum number of commits the renderer will display in the launcher banner.
 * Mirrors the extension's `texra.git.numberOfCommitsToShow` default (20). The
 * desktop currently has no per-user override; if/when one is wired the cap
 * stays here as a defence-in-depth bound.
 */
const DEFAULT_COMMIT_LIMIT = 20;
const MAX_COMMIT_LIMIT = 1000;

/** Field separator used inside `git log --pretty=format` (literal TAB). */
const FIELD_SEPARATOR = '\t';

/**
 * `%h` short hash, `%s` subject, `%cr` committer date relative. Tabs separate
 * fields so subjects with literal `: ` survive the round-trip.
 */
const COMMIT_PRETTY_FORMAT = `%h${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%cr`;

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

export interface DesktopGitCommitsResult {
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
      // Bot review (#3817) flagged that the prior `existsSync('.git')` probe
      // wrongly reports `false` when the user opens a subdirectory inside a
      // repo (`.git` only exists at the repo root). Use `git rev-parse
      // --is-inside-work-tree` instead — that's also what handles the
      // `.git`-as-pointer-file case for worktrees and submodules. The cost
      // is one extra `git` invocation up front but the call is fast (<10ms
      // typical) so we eat it for correctness.
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['rev-parse', '--is-inside-work-tree'],
          { cwd: workspace, timeout: GIT_TIMEOUT_MS },
        );
        if (stdout.trim() !== 'true') {
          return { commits: [], isGitRepo: false };
        }
      } catch {
        // `git` missing from PATH, not a repo, or rev-parse failed for any
        // other reason — treat as "not a repo". Avoid surfacing this via
        // `onError` because it's the steady-state for any non-git workspace
        // and would spam logs.
        return { commits: [], isGitRepo: false };
      }

      try {
        const { stdout } = await execFileAsync(
          'git',
          [
            // `--no-pager` is portable across platforms (no dependency on
            // `cat` being on PATH, which broke on Windows per #3817).
            // `execFile` already runs git non-tty so a pager wouldn't
            // normally engage, but we pin it explicitly anyway.
            '--no-pager',
            'log',
            '-n',
            String(limit),
            `--pretty=format:${COMMIT_PRETTY_FORMAT}`,
          ],
          {
            cwd: workspace,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: MAX_BUFFER_BYTES,
          },
        );
        return { commits: parseCommitLog(stdout), isGitRepo: true };
      } catch (error) {
        // `git` missing from PATH, not a repo, or any other failure -> empty
        // list. We still report `isGitRepo: true` because the rev-parse
        // probe already passed; surfacing "no commits yet" is more accurate
        // than pretending the user is outside a repo and would otherwise
        // mask legitimate empty-repo states.
        options.onError?.(error);
        return { commits: [], isGitRepo: true };
      }
    },
  };
}

/**
 * Convert tab-separated `git log` output into the `<hash>: <subject>
 * (<relative>)` label shape the renderer expects.
 *
 * Exported for unit tests so we can pin the behaviour against fixtures that
 * include awkward subjects (literal `: `, embedded tabs, blank lines).
 */
export function parseCommitLog(stdout: string): string[] {
  if (!stdout) return [];
  const lines = stdout.split('\n');
  const commits: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) continue;
    // Split on the first two TABs only so subjects containing tabs
    // (rare but legal) round-trip correctly.
    const firstTab = line.indexOf(FIELD_SEPARATOR);
    if (firstTab < 0) continue;
    const lastTab = line.lastIndexOf(FIELD_SEPARATOR);
    if (lastTab <= firstTab) continue;
    const hash = line.slice(0, firstTab);
    const subject = line.slice(firstTab + 1, lastTab);
    const relative = line.slice(lastTab + 1);
    if (!hash || !subject || !relative) continue;
    commits.push(`${hash}: ${subject} (${relative})`);
  }
  return commits;
}

function clampCommitLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_COMMIT_LIMIT;
  const rounded = Math.floor(value);
  if (rounded <= 0) return DEFAULT_COMMIT_LIMIT;
  if (rounded > MAX_COMMIT_LIMIT) return MAX_COMMIT_LIMIT;
  return rounded;
}
