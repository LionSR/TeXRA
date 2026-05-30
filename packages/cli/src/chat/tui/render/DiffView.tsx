// Unified-diff renderer for edit-approval modals + tool cards.
//
// Phase 2 produces line-by-line `diff` hunks coloured with ink Text
// (green added / red removed / dim context). `cli-highlight`-based syntax
// highlighting is wired in alongside markdown rendering in Phase 3.

import { Box, Text } from 'ink';
import { structuredPatch, type StructuredPatchHunk } from 'diff';
import stringWidth from 'string-width';

import { wrapAnsiToWidth } from './ansiWrap';

export type Hunk = StructuredPatchHunk;

export interface InlinePatchGroup {
  readonly fileLabel: string;
  readonly hunks: readonly Hunk[];
}

export interface DiffDisplayLine {
  readonly kind: 'added' | 'context' | 'header' | 'removed' | 'overflow';
  readonly text: string;
}

export interface DiffStats {
  readonly added: number;
  readonly removed: number;
  readonly hunks: number;
}

const NO_NEWLINE_MARKER = '\\';
const MIN_DIFF_WIDTH = 20;
const DEFAULT_DIFF_WIDTH = 74;
const COMPACT_DIFF_DISPLAY_LINES = 3;

type OverflowMarkerKind = 'hidden' | 'more' | 'previous';

/** Compute hunks once; callers reuse for both stats and the renderer. */
export function buildHunks(
  fileLabel: string,
  original: string,
  proposed: string,
): Hunk[] {
  return structuredPatch(fileLabel, fileLabel, original, proposed, '', '', {
    context: 3,
  }).hunks;
}

export function statsFromHunks(hunks: readonly Hunk[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      const first = line[0];
      if (first === '+') added += 1;
      else if (first === '-') removed += 1;
    }
  }
  return { added, removed, hunks: hunks.length };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function editCandidate(
  input: unknown,
  fallbackFileLabel: string,
):
  | {
      readonly fileLabel: string;
      readonly oldText: string;
      readonly newText: string;
    }
  | undefined {
  if (!isRecord(input)) return undefined;
  const oldText = stringField(input, ['old_string', 'old_str']);
  const newText = stringField(input, ['new_string', 'new_str']);
  if (oldText === undefined || newText === undefined) return undefined;
  return {
    fileLabel: stringField(input, ['path', 'file_path']) ?? fallbackFileLabel,
    oldText,
    newText,
  };
}

export function editPatchGroups(
  input: unknown,
): readonly InlinePatchGroup[] | undefined {
  if (!isRecord(input)) return undefined;
  const fileLabel = stringField(input, ['path', 'file_path']) ?? 'edit';
  const edits = input.edits;
  const candidates = Array.isArray(edits)
    ? edits.map((edit) => editCandidate(edit, fileLabel))
    : [editCandidate(input, fileLabel)];

  const groups = candidates.flatMap((candidate) => {
    if (!candidate) return [];
    const hunks = buildHunks(
      candidate.fileLabel,
      candidate.oldText,
      candidate.newText,
    );
    return hunks.length > 0 ? [{ fileLabel: candidate.fileLabel, hunks }] : [];
  });
  return groups.length > 0 ? groups : undefined;
}

export function diffDisplayLines(
  hunks: readonly Hunk[],
  maxHunkLines = 0,
): DiffDisplayLine[] {
  return hunks.flatMap((hunk) => {
    const lines = hunk.lines.filter(
      (line) => !line.startsWith(NO_NEWLINE_MARKER),
    );
    const visible = maxHunkLines > 0 ? lines.slice(0, maxHunkLines) : lines;
    const remaining = maxHunkLines > 0 ? lines.length - maxHunkLines : 0;
    const hunkHeader = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
    const rendered: DiffDisplayLine[] = [
      { kind: 'header', text: hunkHeader },
      ...visible.map((line): DiffDisplayLine => {
        const marker = line[0];
        if (marker === '+') return { kind: 'added', text: line };
        if (marker === '-') return { kind: 'removed', text: line };
        return { kind: 'context', text: line };
      }),
    ];
    if (remaining > 0) {
      rendered.push({
        kind: 'overflow',
        text: `… ${remaining} more lines`,
      });
    }
    return rendered;
  });
}

export function wrappedDiffDisplayLines(
  hunks: readonly Hunk[],
  width: number,
  maxHunkLines = 0,
): DiffDisplayLine[] {
  const diffWidth = Math.max(MIN_DIFF_WIDTH, width);
  return diffDisplayLines(hunks, maxHunkLines).flatMap((line) =>
    wrapAnsiToWidth(line.text, diffWidth)
      .split('\n')
      .map((text): DiffDisplayLine => ({ ...line, text })),
  );
}

export function diffVisualRowCount(
  hunks: readonly Hunk[],
  width: number,
  maxHunkLines = 0,
): number {
  return wrappedDiffDisplayLines(hunks, width, maxHunkLines).length;
}

export function boundedDiffDisplayLines(
  hunks: readonly Hunk[],
  maxHunkLines = 0,
  maxDisplayLines = 0,
): DiffDisplayLine[] {
  return scrollBoundedDiffDisplayLines(hunks, maxHunkLines, maxDisplayLines, 0);
}

export function maxDiffScrollOffset(
  totalLines: number,
  maxDisplayLines: number,
): number {
  if (
    maxDisplayLines <= COMPACT_DIFF_DISPLAY_LINES ||
    totalLines <= maxDisplayLines
  ) {
    return 0;
  }
  return Math.max(0, totalLines - Math.max(1, maxDisplayLines - 1));
}

function clipToWidth(text: string, width: number): string {
  let clipped = '';
  for (const char of text) {
    if (stringWidth(clipped + char) > width) break;
    clipped += char;
  }
  return clipped;
}

function overflowMarkerText(
  kind: OverflowMarkerKind,
  count: number,
  width?: number,
): string {
  const candidates =
    kind === 'hidden'
      ? [`... ${count} rows hidden`, `... ${count} hidden`]
      : kind === 'previous'
        ? [`... ${count} previous rows`, `... ${count} prev rows`]
        : [`... ${count} more rows`, `... +${count} rows`];
  if (width === undefined) return candidates[0] ?? '';

  const markerWidth = Math.max(MIN_DIFF_WIDTH, width);
  return (
    candidates.find((candidate) => stringWidth(candidate) <= markerWidth) ??
    clipToWidth(candidates.at(-1) ?? '', markerWidth)
  );
}

function representativeDiffLineIndex(
  lines: readonly DiffDisplayLine[],
): number {
  const changedIndex = lines.findIndex(
    (line) => line.kind === 'added' || line.kind === 'removed',
  );
  if (changedIndex >= 0) return changedIndex;

  const contentIndex = lines.findIndex((line) => line.kind !== 'overflow');
  return Math.max(0, contentIndex);
}

function compactBoundedDiffDisplayLines(
  lines: readonly DiffDisplayLine[],
  maxDisplayLines: number,
  width?: number,
): DiffDisplayLine[] {
  const visibleBudget = Math.max(1, maxDisplayLines);
  const visibleCount = visibleBudget === 1 ? 1 : visibleBudget - 1;
  const anchor = representativeDiffLineIndex(lines);
  const start = Math.max(0, Math.min(anchor, lines.length - visibleCount));
  const visibleLines = lines.slice(start, start + visibleCount);
  if (visibleBudget === 1) return visibleLines;

  const hiddenRows = Math.max(0, lines.length - visibleLines.length);
  if (hiddenRows === 0) return visibleLines;

  return [
    ...visibleLines,
    {
      kind: 'overflow',
      text: overflowMarkerText('hidden', hiddenRows, width),
    },
  ];
}

export function scrollBoundedDiffDisplayLines(
  hunks: readonly Hunk[],
  maxHunkLines = 0,
  maxDisplayLines = 0,
  scrollOffset = 0,
  width?: number,
): DiffDisplayLine[] {
  const lines =
    width === undefined
      ? diffDisplayLines(hunks, maxHunkLines)
      : wrappedDiffDisplayLines(hunks, width, maxHunkLines);
  if (maxDisplayLines <= 0 || lines.length <= maxDisplayLines) return lines;
  if (maxDisplayLines <= COMPACT_DIFF_DISPLAY_LINES) {
    return compactBoundedDiffDisplayLines(lines, maxDisplayLines, width);
  }

  const offset = Math.max(
    0,
    Math.min(scrollOffset, maxDiffScrollOffset(lines.length, maxDisplayLines)),
  );
  const hiddenBefore = offset;
  const reserveBefore = hiddenBefore > 0 ? 1 : 0;
  const contentSlotsWithoutAfter = Math.max(0, maxDisplayLines - reserveBefore);
  const reserveAfter = offset + contentSlotsWithoutAfter < lines.length ? 1 : 0;
  const visibleCount = Math.max(
    0,
    maxDisplayLines - reserveBefore - reserveAfter,
  );
  const visibleLines = lines.slice(offset, offset + visibleCount);
  const hiddenAfter = Math.max(0, lines.length - (offset + visibleCount));
  return [
    ...(hiddenBefore > 0
      ? [
          {
            kind: 'overflow' as const,
            text: overflowMarkerText('previous', hiddenBefore, width),
          },
        ]
      : []),
    ...visibleLines,
    ...(hiddenAfter > 0
      ? [
          {
            kind: 'overflow' as const,
            text: overflowMarkerText('more', hiddenAfter, width),
          },
        ]
      : []),
  ];
}

export interface DiffViewProps {
  readonly hunks: readonly Hunk[];
  /** Maximum total rendered diff rows before truncating; 0 = no truncation. */
  readonly maxDisplayLines?: number;
  /** Maximum context lines per hunk before truncating; 0 = no truncation. */
  readonly maxHunkLines?: number;
  /** Starting diff row when maxDisplayLines truncates the display. */
  readonly scrollOffset?: number;
  readonly width?: number;
}

export function DiffView(props: DiffViewProps): React.JSX.Element {
  const maxDisplayLines = props.maxDisplayLines ?? 0;
  const max = props.maxHunkLines ?? 0;
  const width = Math.max(MIN_DIFF_WIDTH, props.width ?? DEFAULT_DIFF_WIDTH);
  const lines = scrollBoundedDiffDisplayLines(
    props.hunks,
    max,
    maxDisplayLines,
    props.scrollOffset ?? 0,
    width,
  );

  return (
    <Box flexDirection="column">
      {lines.map((line, li) => (
        <DiffLine key={li} line={line} width={width} />
      ))}
    </Box>
  );
}

/**
 * Full-width band backgrounds for changed lines — a muted green/red that fills
 * the whole row (GitHub/Codex-style), so additions and removals read as solid
 * bands rather than just tinted text. Context lines stay un-banded and dim.
 */
export const DIFF_BAND_BG: Partial<Record<DiffDisplayLine['kind'], string>> = {
  added: '#1f3a28',
  removed: '#4a2526',
};

/**
 * Pad every visual row out to `width` columns. Ink only paints a background
 * behind the glyphs it draws, so without this the band would stop at the end
 * of the text; padding extends it across the full row. `string-width` measures
 * display columns so wide glyphs (σ, ℂ, ∑ …) and emoji pad correctly.
 */
export function fillRows(text: string, width: number): string {
  return text
    .split('\n')
    .map((row) => row + ' '.repeat(Math.max(0, width - stringWidth(row))))
    .join('\n');
}

function DiffLine({
  line,
  width,
}: {
  readonly line: DiffDisplayLine;
  readonly width: number;
}): React.JSX.Element {
  const content = wrapAnsiToWidth(line.text, width);
  const bg = DIFF_BAND_BG[line.kind];
  if (bg) {
    return <Text backgroundColor={bg}>{fillRows(content, width)}</Text>;
  }
  return <Text dimColor>{content}</Text>;
}
