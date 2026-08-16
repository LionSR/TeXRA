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

import { executeCommand } from '@utils/system/execUtils';
import { isGitRepository } from '@utils/git/isGitRepository';
import { splitOutputLines } from '@utils/text/stringUtils';

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
async function readGit(
  workspace: string,
  args: readonly string[],
  options: GitReadOptions,
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
export async function readRecentCommitLabels(
  workspacePath: string,
  limit: number,
  options: GitReadOptions = {},
): Promise<string[] | undefined> {
  const output = await readGit(
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
}

/**
 * Probing recent-commits read: reports `isGitRepo: false` when the workspace
 * is not a repository, otherwise the labels (`[]` when the log read fails —
 * the probe already passed, so a failed log is still a git repo).
 */
export async function readRecentCommits(
  workspacePath: string,
  limit: number,
  options: GitReadOptions = {},
): Promise<GitRecentCommits> {
  if (!(await isGitRepository(workspacePath))) {
    return { commits: [], isGitRepo: false };
  }
  const commits = await readRecentCommitLabels(workspacePath, limit, options);
  return { commits: commits ?? [], isGitRepo: true };
}

/**
 * Live repository state: branch, change totals, and upstream sync.
 * `isGitRepository` is the literal `true` — a non-repo workspace returns
 * `undefined` and the host maps that to its own wire constant.
 */
export interface GitEnvironmentSummary {
  isGitRepository: true;
  branch?: string;
  upstream?: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  ahead: number;
  behind: number;
}

/**
 * Probe and read the repository's environment summary. Returns `undefined`
 * when `workspacePath` is not inside a git working tree.
 */
export async function readGitEnvironmentSummary(
  workspacePath: string,
  options: GitReadOptions = {},
): Promise<GitEnvironmentSummary | undefined> {
  if (!(await isGitRepository(workspacePath))) {
    return undefined;
  }

  const [branchOutput, statusOutput, numstatOutput, upstreamOutput] =
    await Promise.all([
      readGit(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD'], options),
      readGit(
        workspacePath,
        ['status', '--short', '--untracked-files=normal'],
        options,
      ),
      readGit(workspacePath, ['diff', '--numstat', 'HEAD', '--'], options),
      readGit(
        workspacePath,
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        options,
        false,
      ),
    ]);
  const { additions, deletions } = parseNumstat(numstatOutput);
  const changedFiles = splitOutputLines(statusOutput ?? '').length;
  const branch =
    branchOutput && branchOutput !== 'HEAD' ? branchOutput : undefined;
  const upstream = upstreamOutput || undefined;
  let ahead = 0;
  let behind = 0;

  if (upstream) {
    const divergence = await readGit(
      workspacePath,
      ['rev-list', '--left-right', '--count', `HEAD...${upstream}`],
      options,
    );
    [ahead, behind] = parseDivergence(divergence);
  }

  return {
    isGitRepository: true,
    ...(branch && { branch }),
    ...(upstream && { upstream }),
    changedFiles,
    additions,
    deletions,
    ahead,
    behind,
  };
}

function parseNumstat(output: string | undefined): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of splitOutputLines(output ?? '')) {
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
