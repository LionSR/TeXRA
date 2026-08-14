// Third-party imports
import { z } from 'zod';
import type { ToolFileAttachment } from '@shared/schemas';
import { clamp } from '@utils/core';

// Local imports

/** Canonical 1-based inclusive line range for tool view_range fields. */
export const ViewRangeSchema = z
  .tuple([z.int().min(1), z.int().min(1)])
  .refine(([start, end]) => end >= start, {
    error: 'view_range[1] must be greater than or equal to view_range[0]',
  });

/** Maximum lines returned in a single file view before truncation. */
const READ_FILE_MAX_LINES = 2000;

/** Default width for line number padding */
const LINE_NUMBER_WIDTH = 6;

/**
 * Slice an array using a 1-based inclusive `[start, end]` line range, clamped
 * to the array bounds. Canonical semantics shared by every tool that slices
 * file/output lines by view range (read_file, text_editor, executions).
 */
export function sliceLineRange<T>(
  lines: readonly T[],
  start: number,
  end: number,
): T[] {
  const from = Math.max(start - 1, 0);
  const to = clamp(end, from, lines.length);
  return lines.slice(from, to);
}

/**
 * Format lines with line numbers for display in tool output.
 * @param lines - Array of lines to format
 * @param startingLine - 1-based line number for the first line (default: 1)
 * @param width - Padding width for line numbers (default: 6)
 * @returns Array of formatted lines with line number prefix and tab separator
 */
export function formatLinesWithNumbers(
  lines: string[],
  startingLine: number = 1,
  width: number = LINE_NUMBER_WIDTH,
): string[] {
  return lines.map((line, index) => {
    const lineNumber = startingLine + index;
    const prefix = lineNumber.toString().padStart(width, ' ');
    return `${prefix}\t${line}`;
  });
}

// ============================================================================
// Shared file-view formatting
// ============================================================================

export interface FileViewOptions {
  /** Display path used in the summary (e.g., "src/foo.ts" or "/memories/notes.md"). */
  path: string;
  /** All lines of the file. */
  lines: string[];
  /**
   * Optional 1-based `[start, end]` (both inclusive) line range.
   * When omitted or nullish, the full file is shown.
   * Values are clamped to the file bounds automatically.
   */
  viewRange?: [number, number] | null;
  /** Max visible lines before truncation. Defaults to READ_FILE_MAX_LINES (2000). */
  maxLines?: number;
  /** Optional suffix appended to the summary (e.g., memory metadata). */
  summarySuffix?: string;
}

export interface FileViewResult {
  status: 'executed';
  output: string;
  summary: string;
  /** Optional file attachments carried alongside the view (e.g. images extracted from an email message). */
  files?: ToolFileAttachment[];
}

/**
 * Shared pipeline for displaying file content with line numbers, truncation,
 * and a standardised "Read …" summary.  Used by read_file, text_editor view,
 * memory view, and executions readFile.
 */
export function formatFileView({
  path: filePath,
  lines,
  viewRange,
  maxLines = READ_FILE_MAX_LINES,
  summarySuffix = '',
}: FileViewOptions): FileViewResult {
  const totalLines = lines.length;
  const rangeProvided = viewRange != null;
  const startLine = Math.max(viewRange?.[0] ?? 1, 1);
  const endLine = Math.min(viewRange?.[1] ?? totalLines, totalLines);
  // Lines in the requested range, clamped to the file bounds and floored at
  // zero so an empty (start > end) range never reports negative lines.
  const rangeSize = Math.max(endLine - startLine + 1, 0);
  const truncated = rangeSize > maxLines;
  const visibleEndLine = Math.min(endLine, startLine + maxLines - 1);
  const visibleLines = sliceLineRange(lines, startLine, visibleEndLine);
  const visibleCount = visibleLines.length;

  // -- output ---------------------------------------------------------------
  const segments: string[] = [];
  if (visibleCount > 0) {
    segments.push(formatLinesWithNumbers(visibleLines, startLine).join('\n'));
  }
  if (truncated) {
    segments.push(`...(truncated, ${rangeSize - maxLines} more lines)`);
  }

  // -- summary --------------------------------------------------------------
  let summary: string;

  if (visibleCount === 0) {
    const reason =
      totalLines === 0 ? 'file is empty' : 'no lines in requested range';
    summary = `Read ${filePath} (${reason})`;
  } else {
    const lastVisibleLine = startLine + visibleCount - 1;
    const isFullRead =
      !rangeProvided &&
      !truncated &&
      startLine === 1 &&
      lastVisibleLine === totalLines;

    if (isFullRead) {
      summary = `Read ${filePath}`;
    } else {
      const rangeLabel =
        startLine === lastVisibleLine
          ? `line ${startLine}`
          : `lines ${startLine}-${lastVisibleLine}`;
      summary = `Read ${rangeLabel} of ${filePath}`;
    }
  }

  if (summarySuffix) {
    summary += summarySuffix;
  }

  return { status: 'executed', output: segments.join('\n'), summary };
}

/**
 * Format tool output with a header and content.
 */
export function formatToolOutput(
  header: string,
  content: string | string[] | null,
  noMatchesText: string = '(no entries)',
): string {
  if (!content || (Array.isArray(content) && content.length === 0)) {
    return `${header}\n${noMatchesText}`;
  }
  const body = Array.isArray(content) ? content.join('\n') : content;
  return `${header}\n${body}`;
}

// ============================================================================
// Offset-based pagination for tool listings
// ============================================================================

/**
 * Slice an array by offset/limit and build display header + "next page" hint.
 *
 * All entries are loaded first then sliced client-side — this bounds the
 * text returned to the model, not the I/O cost of building the listing.
 */
export function paginateToolListing<T>(
  entries: readonly T[],
  offset: number,
  limit: number,
): { page: readonly T[]; start: number; end: number; total: number } {
  const total = entries.length;
  const safeOffset = total > 0 ? Math.min(offset, total - 1) : 0;
  const page = entries.slice(safeOffset, safeOffset + limit);
  return { page, start: safeOffset + 1, end: safeOffset + page.length, total };
}

/** Format a "N more — use offset: X" hint, or empty string if no more pages. */
export function formatPaginationHint(end: number, total: number): string {
  if (end >= total) return '';
  return `\n(${total - end} more; use offset: ${end} to see next page)`;
}
