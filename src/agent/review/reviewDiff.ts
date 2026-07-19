/**
 * Working-tree diff collection for the local agent review feature.
 *
 * Computes the diff of the working tree against the repository's main
 * branch (merge-base), optionally inlining submodule changes and
 * synthesizing pseudo-diffs for untracked files, so the whole change set
 * fits in one reviewable text blob.
 *
 * Host-neutral: uses simple-git for git operations; no vscode.
 */

// Node imports
import * as path from 'node:path';

// Third-party imports
import simpleGit, { type SimpleGit } from 'simple-git';

// Local imports
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import * as logger from '@logger/logUtils';
import { platform } from '@platform/platform';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { makeMachineGitEnv } from '@utils/system/platformPaths';
import { splitContentLines, splitOutputLines } from '@utils/text/stringUtils';

// Local file imports
import { normalizeReviewFilePath } from './reviewIssues';

const GIT_TIMEOUT_MS = 30_000;

/** Branch names probed when origin/HEAD is not configured. */
const BASE_BRANCH_CANDIDATES = ['main', 'master', 'trunk', 'develop'];

const MAX_UNTRACKED_FILES = 25;
const MAX_UNTRACKED_FILE_LINES = 400;
const MAX_UNTRACKED_FILE_BYTES = 200 * 1024;
/** Overall cap on the diff text sent to the model (~40k tokens). */
const MAX_REVIEW_DIFF_CHARS = 160_000;

export interface CollectReviewDiffOptions {
  /** Any path inside the repository; the diff always covers the whole repo. */
  cwd: string;
  includeUntracked: boolean;
  includeSubmodules: boolean;
  /**
   * Explicit base for commit-triggered reviews. When omitted, the collector
   * reviews the current working tree against the main branch.
   */
  baseRef?: string;
  /** User-facing label for {@link baseRef}. */
  baseDescription?: string;
  /**
   * Explicit base *branch* to diff against, with merge-base semantics (like
   * the auto-detected main branch). Set by the "Diff Against…" picker;
   * ignored when {@link baseRef} is provided.
   */
  baseBranch?: string;
}

interface ReviewDiff {
  /** Absolute path of the repository root all paths are relative to. */
  repoRoot: string;
  /** Ref or commit the working tree was diffed against. */
  baseRef: string;
  /** Human-readable description of the base, for prompts and the UI. */
  baseDescription: string;
  /** Unified diff text; empty string when there is nothing to review. */
  diff: string;
  /** Repository-relative paths of changed (and included untracked) files. */
  changedFiles: string[];
  /** True when the diff was cut to fit the size cap. */
  truncated: boolean;
}

export type CollectReviewDiffResult =
  { ok: true; value: ReviewDiff } | { ok: false; reason: string };

function makeGit(cwd: string): SimpleGit {
  // makeMachineGitEnv() strips helper-invoking env keys and extends PATH so
  // GUI-launched hosts (VS Code from the Dock, the Electron desktop app), whose
  // minimal PATH omits Homebrew / /usr/local/bin, can still resolve `git`.
  return simpleGit(cwd, { timeout: { block: GIT_TIMEOUT_MS } }).env(
    makeMachineGitEnv(),
  );
}

/** Run a git command, returning stdout on success and null on error. */
async function rawGit(sg: SimpleGit, args: string[]): Promise<string | null> {
  try {
    return await sg.raw(args);
  } catch (err) {
    logger.debug(
      'reviewDiff',
      `git ${args.join(' ')} failed: ${toErrorMessage(err)}`,
    );
    return null;
  }
}

/** True when the content looks binary (NUL byte in the leading bytes). */
function isProbablyBinary(content: Uint8Array): boolean {
  return content.subarray(0, 8000).includes(0);
}

/**
 * True when `file` belongs to the collected change set. Prefix matches keep
 * issues inside changed submodules, whose diff entries name the submodule
 * directory rather than the inner file — this matcher lives next to the
 * diff collection so that knowledge stays in one module.
 */
export function isPathInChangeSet(
  changedFiles: readonly string[],
  file: string,
): boolean {
  const known = changedFiles.map(normalizeReviewFilePath);
  const candidate = normalizeReviewFilePath(file);
  return known.some(
    (entry) => entry === candidate || candidate.startsWith(`${entry}/`),
  );
}

interface BaseBranch {
  /** Full ref usable as a diff base (e.g. "origin/main" or "main"). */
  ref: string;
  /** Bare branch name, for comparison against the current branch. */
  shortName: string;
}

/**
 * Resolve the repository's main branch: origin/HEAD first, then well-known
 * names — each probed as a local branch and as an origin remote-tracking
 * ref, so a clone without a local main (e.g. a manually added remote with
 * no origin/HEAD) still resolves. Local wins over remote for a name.
 */
async function detectBaseBranch(sg: SimpleGit): Promise<BaseBranch | null> {
  const originHead = await rawGit(sg, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  if (originHead) {
    const ref = originHead.trim();
    return { ref, shortName: ref.replace(/^origin\//, '') };
  }
  const verified = await Promise.all(
    BASE_BRANCH_CANDIDATES.map(async (candidate) => {
      const [local, origin] = await Promise.all([
        rawGit(sg, [
          'rev-parse',
          '--verify',
          '--quiet',
          `refs/heads/${candidate}`,
        ]),
        rawGit(sg, [
          'rev-parse',
          '--verify',
          '--quiet',
          `refs/remotes/origin/${candidate}`,
        ]),
      ]);
      return { candidate, local, origin };
    }),
  );
  for (const { candidate, local, origin } of verified) {
    // rawGit returns null for non-existent refs: simple-git's .raw() rejects on
    // any non-zero exit, caught and converted to null; a truthy SHA means "found".
    if (local) {
      return { ref: candidate, shortName: candidate };
    }
    if (origin) {
      return { ref: `origin/${candidate}`, shortName: candidate };
    }
  }
  return null;
}

/**
 * Resolve a user-chosen base branch (from the "Diff Against…" picker). The ref
 * is verified so a stale pick degrades to a clear failure rather than a
 * confusing empty diff. The short name drops a leading `origin/` for
 * user-facing labels in on-branch fallback descriptions.
 */
async function resolveBaseBranch(
  sg: SimpleGit,
  branch: string,
): Promise<BaseBranch | null> {
  const verified = await rawGit(sg, [
    'rev-parse',
    '--verify',
    '--quiet',
    branch,
  ]);
  if (!verified) return null;
  return { ref: branch, shortName: branch.replace(/^origin\//, '') };
}

/** A branch offered by the "Diff Against…" picker. */
export interface BaseBranchCandidate {
  /** Ref usable as a diff base: a local branch name or `origin/<name>`. */
  ref: string;
  /** True when this is the currently checked-out branch. */
  current: boolean;
}

/**
 * List local and origin branches for the "Diff Against…" picker, flagging the
 * current branch. Best-effort: returns an empty list when the repository
 * cannot be resolved, leaving the picker with just its auto-detect default.
 */
export async function listBaseBranchCandidates(
  cwd: string,
): Promise<BaseBranchCandidate[]> {
  let sg: SimpleGit;
  try {
    sg = makeGit(cwd);
  } catch {
    return [];
  }
  const repoRoot = (await rawGit(sg, ['rev-parse', '--show-toplevel']))?.trim();
  if (!repoRoot) return [];
  const sgRoot = makeGit(repoRoot);
  const [headOut, localsOut, remotesOut] = await Promise.all([
    rawGit(sgRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    rawGit(sgRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    rawGit(sgRoot, [
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/remotes/origin',
    ]),
  ]);
  const current = headOut?.trim();
  const seen = new Set<string>();
  const candidates: BaseBranchCandidate[] = [];
  for (const ref of [
    ...splitOutputLines(localsOut ?? ''),
    ...splitOutputLines(remotesOut ?? ''),
  ]) {
    // `origin/HEAD` is a symbolic alias, not a real branch to diff against.
    if (!ref || ref === 'origin/HEAD' || seen.has(ref)) continue;
    seen.add(ref);
    candidates.push({ ref, current: ref === current });
  }
  return candidates;
}

/**
 * Pick the diff base when the main branch itself is checked out: the
 * uncommitted changes when the tree is dirty, otherwise the latest commit —
 * so a run-on-commit review right after `git commit` still has something
 * to look at.
 */
async function resolveOnBaseBranch(
  sg: SimpleGit,
  branch: string,
): Promise<Pick<ReviewDiff, 'baseRef' | 'baseDescription'>> {
  // `diff --name-only HEAD` is empty on a clean tree (exit 0, no output) and
  // lists changed files on a dirty tree (exit 0, non-empty output). This
  // avoids `diff --quiet`, whose exit code 1 ("differences found") simple-git
  // cannot distinguish from a genuine command failure (both throw GitResponseError).
  // Treat a git failure (null) conservatively as dirty: better to include HEAD
  // (possibly redundant) than to silently skip uncommitted changes by picking HEAD^.
  const dirtyFiles = await rawGit(sg, ['diff', '--name-only', 'HEAD']);
  const treeClean = dirtyFiles !== null && !dirtyFiles.trim();
  if (!treeClean) {
    return {
      baseRef: 'HEAD',
      baseDescription: `last commit on ${branch} (uncommitted changes)`,
    };
  }
  if (await rawGit(sg, ['rev-parse', '--verify', '--quiet', 'HEAD^'])) {
    return {
      baseRef: 'HEAD^',
      baseDescription: `previous commit on ${branch} (latest commit)`,
    };
  }
  // Clean tree on the branch's initial commit: nothing to review; the
  // empty HEAD diff reports that without claiming uncommitted changes.
  return {
    baseRef: 'HEAD',
    baseDescription: `last commit on ${branch}`,
  };
}

/**
 * Synthesize a unified-diff-style entry for an untracked file so it can be
 * reviewed alongside tracked changes. Binary and oversized content degrades
 * to a one-line marker — the file's presence is often the issue (caches,
 * databases, build artifacts), not its bytes.
 */
export function buildUntrackedFileDiff(
  relativePath: string,
  content: Uint8Array,
): string {
  const header = `diff --git a/${relativePath} b/${relativePath}\nnew file (untracked)\n`;
  if (isProbablyBinary(content)) {
    return `${header}Binary file ${relativePath} added\n`;
  }

  // TextDecoder (not Buffer) keeps this module runnable on any modern
  // runtime, matching the host-neutral contract in the file header.
  const text = new TextDecoder().decode(
    content.subarray(0, MAX_UNTRACKED_FILE_BYTES),
  );
  const lines = splitContentLines(text);
  if (lines.length === 0) {
    return `${header}(empty file)\n`;
  }

  const shown = lines.slice(0, MAX_UNTRACKED_FILE_LINES);
  const body = shown.map((line) => `+${line}`).join('\n');
  const truncatedNotice =
    lines.length > shown.length || content.length > MAX_UNTRACKED_FILE_BYTES
      ? `\n[... ${relativePath} truncated]`
      : '';
  return `${header}--- /dev/null\n+++ b/${relativePath}\n@@ -0,0 +1,${shown.length} @@\n${body}${truncatedNotice}\n`;
}

/**
 * Collect pseudo-diffs for untracked files. Returns null when the listing
 * command itself fails — silently treating that as "no untracked files"
 * would drop exactly the content (secrets, artifacts) the review exists
 * to catch. An empty listing (no untracked files) is a normal result.
 */
async function collectUntrackedDiffs(
  sg: SimpleGit,
  repoRoot: string,
): Promise<{ diff: string; files: string[] } | null> {
  const listing = await rawGit(sg, [
    'ls-files',
    '--others',
    '--exclude-standard',
  ]);
  if (listing === null) return null;

  const untracked = splitOutputLines(listing);
  const included = untracked.slice(0, MAX_UNTRACKED_FILES);
  const contents = await Promise.all(
    included.map(async (file) => {
      // One byte beyond the cap so buildUntrackedFileDiff still detects
      // and marks truncation for oversized files.
      try {
        const content = await platform().fs.readFileChunk(
          path.join(repoRoot, file),
          0,
          MAX_UNTRACKED_FILE_BYTES + 1,
        );
        return { file, content };
      } catch (error) {
        if (isFileNotFoundError(error) || isNotADirectoryError(error)) {
          return undefined;
        }
        throw new Error(
          `Could not read untracked file "${file}": ${toErrorMessage(error)}`,
          { cause: error },
        );
      }
    }),
  );

  const sections: string[] = [];
  const files: string[] = [];
  for (const entry of contents) {
    if (!entry) continue;
    sections.push(buildUntrackedFileDiff(entry.file, entry.content));
    files.push(entry.file);
  }
  if (untracked.length > included.length) {
    sections.push(
      `[... ${untracked.length - included.length} more untracked files omitted]\n`,
    );
  }
  return { diff: sections.join('\n'), files };
}

/**
 * Collect the reviewable diff. By default this compares the working tree
 * against the merge-base with the main branch. Commit-triggered callers can
 * pass an explicit base ref when they already know the previous HEAD.
 *
 * All paths in the result are relative to {@link ReviewDiff.repoRoot}, which
 * may be above `options.cwd` when the workspace is a repository subfolder.
 */
export async function collectReviewDiff(
  options: CollectReviewDiffOptions,
): Promise<CollectReviewDiffResult> {
  const { includeUntracked, includeSubmodules } = options;

  let sg: SimpleGit;
  try {
    sg = makeGit(options.cwd);
  } catch {
    return { ok: false, reason: 'The workspace is not a git repository.' };
  }

  // `git diff <commit>` always emits repo-relative paths; resolve the root
  // so file reads and editor locations agree with them.
  const repoRoot = (await rawGit(sg, ['rev-parse', '--show-toplevel']))?.trim();
  if (!repoRoot) {
    return { ok: false, reason: 'The workspace is not a git repository.' };
  }

  const sgRoot = makeGit(repoRoot);

  let baseRef: string;
  let baseDescription: string;
  if (options.baseRef) {
    baseRef = options.baseRef;
    baseDescription = options.baseDescription ?? options.baseRef;
  } else {
    const base = options.baseBranch
      ? await resolveBaseBranch(sgRoot, options.baseBranch)
      : await detectBaseBranch(sgRoot);
    if (!base) {
      return {
        ok: false,
        reason: options.baseBranch
          ? `Could not resolve the base branch "${options.baseBranch}"; it may have been deleted.`
          : `Could not find the repository's main branch (looked for origin/HEAD plus local and origin remote-tracking ${BASE_BRANCH_CANDIDATES.join('/')}).`,
      };
    }

    const head = (
      await rawGit(sgRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
    )?.trim();
    const checkedOutBase = options.baseBranch
      ? head === base.ref
      : head === base.shortName;
    if (checkedOutBase) {
      ({ baseRef, baseDescription } = await resolveOnBaseBranch(
        sgRoot,
        base.shortName,
      ));
    } else {
      const mergeBase = await rawGit(sgRoot, ['merge-base', 'HEAD', base.ref]);
      if (!mergeBase) {
        return {
          ok: false,
          reason: `Could not determine the merge base between HEAD and ${base.ref}.`,
        };
      }
      baseRef = mergeBase.trim();
      baseDescription = options.baseBranch
        ? `branch ${base.ref}`
        : `main branch (${base.ref})`;
    }
  }

  const submoduleFlag = includeSubmodules
    ? '--submodule=diff'
    : '--ignore-submodules=all';
  let collected: [
    string | null,
    string | null,
    Awaited<ReturnType<typeof collectUntrackedDiffs>>,
  ];
  try {
    collected = await Promise.all([
      rawGit(sgRoot, ['diff', '--no-color', submoduleFlag, baseRef, '--']),
      rawGit(sgRoot, ['diff', '--name-only', submoduleFlag, baseRef, '--']),
      includeUntracked
        ? collectUntrackedDiffs(sgRoot, repoRoot)
        : Promise.resolve({ diff: '', files: [] }),
    ]);
  } catch (error) {
    return { ok: false, reason: toErrorMessage(error) };
  }
  const [diffText, nameOnly, untracked] = collected;
  // A failed name-only diff must fail the collection too: issue reports are
  // validated against `changedFiles`, so an empty list alongside real diff
  // text would reject every finding as outside the change set.
  if (diffText === null || nameOnly === null) {
    return { ok: false, reason: `git diff against ${baseRef} failed.` };
  }
  if (untracked === null) {
    return {
      ok: false,
      reason: 'Listing untracked files failed (git ls-files).',
    };
  }

  const changedFiles = splitOutputLines(nameOnly);
  let combined = diffText;
  if (untracked.diff) {
    combined = combined ? `${combined}\n${untracked.diff}` : untracked.diff;
    changedFiles.push(...untracked.files);
  }

  let truncated = false;
  if (combined.length > MAX_REVIEW_DIFF_CHARS) {
    combined = `${combined.slice(0, MAX_REVIEW_DIFF_CHARS)}\n[... diff truncated for review]`;
    truncated = true;
  }

  return {
    ok: true,
    value: {
      repoRoot,
      baseRef,
      baseDescription,
      diff: combined.trim() ? combined : '',
      changedFiles,
      truncated,
    },
  };
}
