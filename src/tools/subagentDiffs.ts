import path from 'path';

import { diff_match_patch } from 'diff-match-patch';

import type { OutputFileSummary } from '@agent/runtime/AgentFlowResult';
import type { DiffLine, ExecutionId, StructuredDiff } from '@shared/schemas';
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

const OP_TAG: Record<number, '+' | '-' | ' '> = { 1: '+', [-1]: '-', 0: ' ' };

/**
 * Compute a structured line-level diff between two strings.
 * Each row carries its tag (+/-/space) and a 1-based line number on the
 * old side, the new side, or both (for context). Renderers style the rows
 * directly — no re-running of diff-match-patch downstream.
 *
 * Returns null when the strings are identical.
 */
export function computeStructuredDiff(
  original: string,
  modified: string,
): StructuredDiff | null {
  const dmp = new diff_match_patch();

  // Line-mode: each line becomes one "character" so diff_main operates on
  // whole lines.
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(
    original,
    modified,
  );
  const diffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines_(diffs, lineArray);

  if (diffs.every(([op]) => op === 0)) return null;

  const lines: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const [op, text] of diffs) {
    const tag = OP_TAG[op] ?? ' ';
    const chunkLines = text.split('\n');
    for (let i = 0; i < chunkLines.length; i++) {
      // Drop the empty trailing entry from the split-on-\n.
      if (i === chunkLines.length - 1 && chunkLines[i] === '') continue;
      const row: DiffLine = { tag, text: chunkLines[i] };
      if (tag === ' ') {
        row.oldLine = oldLine++;
        row.newLine = newLine++;
      } else if (tag === '-') {
        row.oldLine = oldLine++;
      } else {
        row.newLine = newLine++;
      }
      lines.push(row);
    }
  }
  return { lines };
}

/** Render a structured diff as the legacy unified-text form (for disk artifacts). */
export function renderUnifiedDiff(diff: StructuredDiff): string {
  const out = diff.lines.map((row) => `${row.tag}${row.text}`);
  if (diff.truncated) out.push('[... diff truncated]');
  return out.join('\n');
}

/**
 * Truncate a structured diff to a maximum number of rows. Sets
 * `truncated: true` so renderers can surface the elision.
 */
export function truncateStructuredDiff(
  diff: StructuredDiff,
  maxLines: number,
): StructuredDiff {
  if (diff.lines.length <= maxLines) return diff;
  return { lines: diff.lines.slice(0, maxLines), truncated: true };
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

        const structured = computeStructuredDiff(original, modified);
        if (structured) {
          const limit = largeChange ? LARGE_CHANGE_DIFF_LINES : MAX_DIFF_LINES;
          const truncated = truncateStructuredDiff(structured, limit);
          // Use full relativePath (with separators replaced) to avoid collisions
          // when multiple files share the same basename in different directories.
          const safeName = o.relativePath.replaceAll(/[\\/]/g, '_');
          const diffRelPath = `diffs/${safeName}.diff`;
          results.set(o.absolutePath, { diffRelPath, largeChange });
          diffsToWrite.push({
            diffRelPath,
            content: renderUnifiedDiff(truncated),
          });
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
