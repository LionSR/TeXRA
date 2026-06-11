/**
 * Working-tree diff collection for the local agent review feature.
 *
 * Computes the diff of the working tree against the repository's main
 * branch (merge-base), optionally inlining submodule changes and
 * synthesizing pseudo-diffs for untracked files, so the whole change set
 * fits in one reviewable text blob.
 *
 * Host-neutral: shells out to git via the shared exec wrapper; no vscode.
 */

// Standard library imports
import { open, type FileHandle } from 'node:fs/promises';
import * as path from 'node:path';

// Local imports
import { executeCommand } from '@utils/system/execUtils';

import { normalizeReviewFilePath } from './reviewIssues';

const CHANNEL = 'AgentReview';
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
}

export interface ReviewDiff {
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
  | { ok: true; value: ReviewDiff }
  | { ok: false; reason: string };

/** Run git, returning stdout on success and null on any failure. */
async function git(cwd: string, args: string[]): Promise<string | null> {
  const result = await executeCommand(['git', ...args], {
    cwd,
    channel: CHANNEL,
    timeout: GIT_TIMEOUT_MS,
  });
  return result.success ? (result.stdout ?? '') : null;
}

/** True when the content looks binary (NUL byte in the leading bytes). */
function isProbablyBinary(content: Buffer): boolean {
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

/** Resolve the repository's main branch: origin/HEAD first, then well-known names. */
async function detectBaseBranch(cwd: string): Promise<BaseBranch | null> {
  const originHead = await git(cwd, [
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
    BASE_BRANCH_CANDIDATES.map((candidate) =>
      git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]),
    ),
  );
  const index = verified.findIndex((sha) => sha !== null);
  if (index === -1) return null;
  const candidate = BASE_BRANCH_CANDIDATES[index];
  return { ref: candidate, shortName: candidate };
}

/**
 * Pick the diff base when the main branch itself is checked out: the
 * uncommitted changes when the tree is dirty, otherwise the latest commit —
 * so a run-on-commit review right after `git commit` still has something
 * to look at.
 */
async function resolveOnBaseBranch(
  cwd: string,
  branch: string,
): Promise<Pick<ReviewDiff, 'baseRef' | 'baseDescription'>> {
  const treeClean = (await git(cwd, ['diff', '--quiet', 'HEAD'])) !== null;
  if (
    treeClean &&
    (await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^']))
  ) {
    return {
      baseRef: 'HEAD^',
      baseDescription: `previous commit on ${branch} (latest commit)`,
    };
  }
  return {
    baseRef: 'HEAD',
    baseDescription: `last commit on ${branch} (uncommitted changes)`,
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
  content: Buffer,
): string {
  const header = `diff --git a/${relativePath} b/${relativePath}\nnew file (untracked)\n`;
  if (isProbablyBinary(content)) {
    return `${header}Binary file ${relativePath} added\n`;
  }

  const text = content.subarray(0, MAX_UNTRACKED_FILE_BYTES).toString('utf8');
  const lines = text.split('\n');
  // Drop the empty trailing element from a final newline.
  if (lines.at(-1) === '') lines.pop();
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
 * Read at most `maxBytes` from the start of a file. Untracked entries can be
 * multi-gigabyte artifacts (databases, caches, build outputs) — exactly the
 * accidental commits this feature exists to catch — so only the capped
 * prefix that can ever be rendered is loaded, never the whole file.
 */
async function readFilePrefix(
  filePath: string,
  maxBytes: number,
): Promise<Buffer | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return undefined; // Vanished or unreadable; skip.
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Collect pseudo-diffs for untracked files. Returns null when the listing
 * command itself fails — silently treating that as "no untracked files"
 * would drop exactly the content (secrets, artifacts) the review exists
 * to catch. An empty listing (no untracked files) is a normal result.
 */
async function collectUntrackedDiffs(
  repoRoot: string,
): Promise<{ diff: string; files: string[] } | null> {
  const listing = await git(repoRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
  ]);
  if (listing === null) return null;

  const untracked = listing.split('\n').filter(Boolean);
  const included = untracked.slice(0, MAX_UNTRACKED_FILES);
  const contents = await Promise.all(
    included.map(async (file) => {
      // One byte beyond the cap so buildUntrackedFileDiff still detects
      // and marks truncation for oversized files.
      const content = await readFilePrefix(
        path.join(repoRoot, file),
        MAX_UNTRACKED_FILE_BYTES + 1,
      );
      return content && { file, content };
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

  // `git diff <commit>` always emits repo-relative paths; resolve the root
  // so file reads and editor locations agree with them.
  const repoRoot = (
    await git(options.cwd, ['rev-parse', '--show-toplevel'])
  )?.trim();
  if (!repoRoot) {
    return { ok: false, reason: 'The workspace is not a git repository.' };
  }

  let baseRef: string;
  let baseDescription: string;
  if (options.baseRef) {
    baseRef = options.baseRef;
    baseDescription = options.baseDescription ?? options.baseRef;
  } else {
    const base = await detectBaseBranch(repoRoot);
    if (!base) {
      return {
        ok: false,
        reason: `Could not find the repository's main branch (looked for origin/HEAD and local ${BASE_BRANCH_CANDIDATES.join('/')}).`,
      };
    }

    const head = (
      await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
    )?.trim();
    if (head === base.shortName) {
      ({ baseRef, baseDescription } = await resolveOnBaseBranch(
        repoRoot,
        base.shortName,
      ));
    } else {
      const mergeBase = await git(repoRoot, ['merge-base', 'HEAD', base.ref]);
      if (!mergeBase) {
        return {
          ok: false,
          reason: `Could not determine the merge base between HEAD and ${base.ref}.`,
        };
      }
      baseRef = mergeBase.trim();
      baseDescription = `main branch (${base.ref})`;
    }
  }

  const submoduleFlag = includeSubmodules
    ? '--submodule=diff'
    : '--ignore-submodules=all';
  const [diffText, nameOnly, untracked] = await Promise.all([
    git(repoRoot, ['diff', '--no-color', submoduleFlag, baseRef, '--']),
    git(repoRoot, ['diff', '--name-only', submoduleFlag, baseRef, '--']),
    includeUntracked
      ? collectUntrackedDiffs(repoRoot)
      : Promise.resolve({ diff: '', files: [] }),
  ]);
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

  const changedFiles = nameOnly.split('\n').filter(Boolean);
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
