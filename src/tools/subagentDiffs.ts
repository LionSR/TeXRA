import path from 'path';

import { diff_match_patch } from 'diff-match-patch';

import type { OutputFileSummary } from '@agent/runtime/AgentFlowResult';
import type { ExecutionId } from '@shared/schemas';
import { AbsoluteFS } from '@utils/files';
import { getRunDir, ensureRunDir } from '@utils/files/taskRunStorage';
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
  const dmp = new diff_match_patch();

  // Convert to line-mode: each line becomes a single "character" so
  // diff_main operates on whole lines, not individual characters.
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(
    original,
    modified,
  );
  const diffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines_(diffs, lineArray);

  // Check if there are any actual changes.
  if (diffs.every(([op]) => op === 0)) return null;

  const PREFIX: Record<number, string> = { 1: '+', [-1]: '-', 0: ' ' };
  const lines: string[] = [];
  for (const [op, text] of diffs) {
    const prefix = PREFIX[op] ?? ' ';
    // Each chunk is one or more complete lines (with trailing \n).
    // Split and prefix each line, dropping the trailing empty entry from split.
    const chunkLines = text.split('\n');
    for (let i = 0; i < chunkLines.length; i++) {
      // Skip the empty string after the final \n
      if (i === chunkLines.length - 1 && chunkLines[i] === '') continue;
      lines.push(`${prefix}${chunkLines[i]}`);
    }
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
  const diffsToWrite: Array<{ diffRelPath: string; content: string }> = [];

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
          const changedLines = (o.added ?? 0) + (o.removed ?? 0);
          largeChange = changedLines / originalLines > LARGE_CHANGE_RATIO;
        }

        const diff = computeReadableDiff(original, modified);
        if (diff) {
          const limit = largeChange ? LARGE_CHANGE_DIFF_LINES : MAX_DIFF_LINES;
          const truncated = truncateDiff(diff, limit);
          // Use full relativePath (with separators replaced) to avoid collisions
          // when multiple files share the same basename in different directories.
          const safeName = o.relativePath.replaceAll(/[\\/]/g, '_');
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
