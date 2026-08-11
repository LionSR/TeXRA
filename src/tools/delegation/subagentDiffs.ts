import path from 'node:path';

import type { ExecutionId } from '@shared/schemas';
import type { OutputFileSummary } from '@shared/schemas/output';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { getRunDir, ensureRunDir } from '@utils/files/runStorageFs';
import {
  diffTextByLine,
  DIFF_DELETE,
  DIFF_EQUAL,
  DIFF_INSERT,
} from '@utils/text/diff';
import { sanitizePathSegment } from '@utils/text/sanitizePathSegment';
import { countLines } from '@utils/text/stringUtils';

/** Maximum lines of diff to include per file in deliveries. */
const MAX_DIFF_LINES = 200;

/** Shorter truncation limit for large changes (>40% of file modified). */
const LARGE_CHANGE_DIFF_LINES = 80;

/**
 * When the changed lines (added + removed) exceed this fraction of the
 * original file's line count, the diff is flagged as a large change.
 * The orchestrator still gets a diff file but truncated shorter.
 */
const LARGE_CHANGE_RATIO = 0.4;

const DIFF_LINE_PREFIX: Readonly<Record<number, string>> = Object.freeze({
  [DIFF_INSERT]: '+',
  [DIFF_DELETE]: '-',
  [DIFF_EQUAL]: ' ',
});

/**
 * Compute a human-readable line-level diff between two strings.
 * Uses diff-match-patch's line-mode diffing (diff_linesToChars_ /
 * diff_charsToLines_) to produce clean whole-line diffs with +/- prefixes.
 * Returns null if the strings are identical.
 */
function computeReadableDiff(
  original: string,
  modified: string,
): string | null {
  const diffs = diffTextByLine(original, modified, {
    cleanupSemantic: false,
  });

  // Check if there are any actual changes.
  if (diffs.every(([op]) => op === DIFF_EQUAL)) return null;

  const lines: string[] = [];
  for (const [op, text] of diffs) {
    const prefix = DIFF_LINE_PREFIX[op] ?? ' ';
    // Each chunk is one or more complete lines (with trailing \n).
    // Split and prefix each line, dropping the trailing empty entry from split.
    const chunkLines = text.split('\n');
    if (chunkLines.at(-1) === '') chunkLines.pop();
    for (const line of chunkLines) lines.push(`${prefix}${line}`);
  }
  return lines.join('\n');
}

/**
 * Truncate diff text to a maximum number of lines.
 * Appends a truncation notice if the diff exceeds the limit.
 */
function truncateDiff(diff: string, maxLines: number): string {
  const lines = diff.split('\n');
  if (lines.length <= maxLines) return diff;
  return lines.slice(0, maxLines).join('\n') + '\n[... diff truncated]';
}

/** Info about a diff file written to the execution's run directory. */
export interface DiffFileInfo {
  /** The relative path within the run directory (e.g. "diffs/chapter1.tex.diff"). */
  diffRelPath: string;
  /** True when the change ratio exceeded the large-change threshold. */
  largeChange: boolean;
}

/**
 * Compute diffs for workflow output files and write them to the execution's
 * run directory as `.diff` files. Returns a map from output absolutePath to
 * diff file info, so the delivery formatter can reference them by path.
 *
 * All diffs are written regardless of change size. Large changes (ratio above
 * {@link LARGE_CHANGE_RATIO}) are flagged so the orchestrator knows the diff
 * may be truncated and can read the full output file for context.
 *
 * Files without an original (new files) or where reading fails are omitted.
 */
export async function computeAndWriteWorkflowDiffs(
  executionId: ExecutionId,
  outputs: OutputFileSummary[],
): Promise<Map<string, DiffFileInfo>> {
  const results = new Map<string, DiffFileInfo>();
  const diffsToWrite: { diffRelPath: string; content: string }[] = [];

  // First pass: compute diffs and decide which to write.
  await Promise.all(
    outputs.map(async (o) => {
      if (!o.originalPath) return;
      try {
        const [original, modified] = await Promise.all([
          AbsoluteFS.read(o.originalPath),
          AbsoluteFS.read(o.absolutePath),
        ]);

        // Flag large changes so the orchestrator knows to also read the
        // full output file — the diff alone may not capture everything.
        let largeChange = false;
        const originalLines = countLines(original);
        if (originalLines > 0 && o.added !== null && o.removed !== null) {
          const changedLines = o.added + o.removed;
          largeChange = changedLines / originalLines > LARGE_CHANGE_RATIO;
        }

        const diff = computeReadableDiff(original, modified);
        if (diff) {
          const limit = largeChange ? LARGE_CHANGE_DIFF_LINES : MAX_DIFF_LINES;
          const truncated = truncateDiff(diff, limit);
          // Use full relativePath (with separators replaced) to avoid collisions
          // when multiple files share the same basename in different directories.
          const safeName = sanitizePathSegment(o.relativePath, {
            invalidCharPattern: /[\\/]/g,
            replacement: '_',
          });
          const diffRelPath = `diffs/${safeName}.diff`;
          results.set(o.absolutePath, { diffRelPath, largeChange });
          diffsToWrite.push({ diffRelPath, content: truncated });
        }
      } catch {
        // File read failure is non-fatal — skip diff for this file.
      }
    }),
  );

  // Second pass: write diff files to disk.
  if (diffsToWrite.length > 0) {
    const runDir = getRunDir(executionId);
    await ensureRunDir(executionId);
    const diffsDir = path.join(runDir, 'diffs');
    await AbsoluteFS.ensureDir(diffsDir);

    await Promise.all(
      diffsToWrite.map(async ({ diffRelPath, content }) => {
        const fullPath = path.join(runDir, diffRelPath);
        await AbsoluteFS.write(fullPath, content);
      }),
    );
  }

  return results;
}
