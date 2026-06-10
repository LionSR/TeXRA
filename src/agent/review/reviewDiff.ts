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
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

// Local imports
import { executeCommand } from '@utils/system/execUtils';

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
  cwd: string;
  includeUntracked: boolean;
  includeSubmodules: boolean;
}

export interface ReviewDiff {
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
  for (const candidate of BASE_BRANCH_CANDIDATES) {
    const verified = await git(cwd, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${candidate}`,
    ]);
    if (verified) {
      return { ref: candidate, shortName: candidate };
    }
  }
  return null;
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
  const probe = content.subarray(0, 8000);
  if (probe.includes(0)) {
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

async function collectUntrackedDiffs(
  cwd: string,
): Promise<{ diff: string; files: string[] }> {
  const listing = await git(cwd, [
    'ls-files',
    '--others',
    '--exclude-standard',
  ]);
  if (!listing) return { diff: '', files: [] };

  const untracked = listing.split('\n').filter(Boolean);
  const included = untracked.slice(0, MAX_UNTRACKED_FILES);
  const sections: string[] = [];
  const files: string[] = [];
  for (const file of included) {
    let content: Buffer;
    try {
      content = await readFile(path.join(cwd, file));
    } catch {
      continue; // Vanished or unreadable; skip.
    }
    sections.push(buildUntrackedFileDiff(file, content));
    files.push(file);
  }
  if (untracked.length > included.length) {
    sections.push(
      `[... ${untracked.length - included.length} more untracked files omitted]\n`,
    );
  }
  return { diff: sections.join('\n'), files };
}

/**
 * Collect the reviewable diff: working tree against the merge-base with the
 * main branch, or against HEAD (uncommitted changes only) when the main
 * branch is checked out.
 */
export async function collectReviewDiff(
  options: CollectReviewDiffOptions,
): Promise<CollectReviewDiffResult> {
  const { cwd, includeUntracked, includeSubmodules } = options;

  if (!(await git(cwd, ['rev-parse', '--is-inside-work-tree']))) {
    return { ok: false, reason: 'The workspace is not a git repository.' };
  }

  const base = await detectBaseBranch(cwd);
  if (!base) {
    return {
      ok: false,
      reason: `Could not find the repository's main branch (looked for origin/HEAD and local ${BASE_BRANCH_CANDIDATES.join('/')}).`,
    };
  }

  const head = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
  let baseRef: string;
  let baseDescription: string;
  if (head === base.shortName) {
    // Already on the main branch: review the uncommitted changes.
    baseRef = 'HEAD';
    baseDescription = `last commit on ${base.shortName} (uncommitted changes)`;
  } else {
    const mergeBase = await git(cwd, ['merge-base', 'HEAD', base.ref]);
    if (!mergeBase) {
      return {
        ok: false,
        reason: `Could not determine the merge base between HEAD and ${base.ref}.`,
      };
    }
    baseRef = mergeBase.trim();
    baseDescription = `main branch (${base.ref})`;
  }

  const submoduleFlag = includeSubmodules
    ? '--submodule=diff'
    : '--ignore-submodules=all';
  const diffText = await git(cwd, [
    'diff',
    '--no-color',
    submoduleFlag,
    baseRef,
    '--',
  ]);
  if (diffText === null) {
    return { ok: false, reason: `git diff against ${baseRef} failed.` };
  }

  const nameOnly = await git(cwd, [
    'diff',
    '--name-only',
    submoduleFlag,
    baseRef,
    '--',
  ]);
  const changedFiles = (nameOnly ?? '').split('\n').filter(Boolean);

  let combined = diffText;
  if (includeUntracked) {
    const untracked = await collectUntrackedDiffs(cwd);
    if (untracked.diff) {
      combined = combined ? `${combined}\n${untracked.diff}` : untracked.diff;
      changedFiles.push(...untracked.files);
    }
  }

  let truncated = false;
  if (combined.length > MAX_REVIEW_DIFF_CHARS) {
    combined = `${combined.slice(0, MAX_REVIEW_DIFF_CHARS)}\n[... diff truncated for review]`;
    truncated = true;
  }

  return {
    ok: true,
    value: {
      baseRef,
      baseDescription,
      diff: combined.trim() ? combined : '',
      changedFiles,
      truncated,
    },
  };
}
