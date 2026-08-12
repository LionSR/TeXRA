// Unified-diff renderer for edit-approval modals + tool cards: `diff` hunks
// render line by line as full-width added/removed bands with dim context rows
// (see DIFF_LINE_STYLE for the color rationale).

import { Box, Text } from 'ink';
import { structuredPatch, type StructuredPatchHunk } from 'diff';

import { wrapAnsiToWidth } from '@cli/tui/ansiWrap';
import { hiddenRowsText, moreRowsText, previousRowsText } from '@cli/tui/overflowText';
import { clampModalWidth } from '@cli/tui/ui/theme';
import { clamp, isObject } from '@utils/core';

import {
  COMPACT_SCROLLABLE_CONTENT_ROWS,
  maxScrollableRowOffset,
  scrollBoundedRows,
} from './scrollBounds';
import { clipToWidth, fillRows, textDisplayWidth } from './terminalText';

type Hunk = StructuredPatchHunk;

export interface InlinePatchGroup {
  readonly fileLabel: string;
  readonly hunks: readonly Hunk[];
}

interface DiffDisplayLine {
  readonly kind: 'added' | 'context' | 'header' | 'removed' | 'overflow';
  readonly text: string;
}

interface DiffStats {
  readonly added: number;
  readonly removed: number;
  readonly hunks: number;
}

const NO_NEWLINE_MARKER = '\\';
const DEFAULT_DIFF_WIDTH = 74;

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
      const first = line.at(0);
      if (first === '+') added += 1;
      else if (first === '-') removed += 1;
    }
  }
  return { added, removed, hunks: hunks.length };
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
  if (!isObject(input)) return undefined;
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
  if (!isObject(input)) return undefined;
  const fileLabel = stringField(input, ['path', 'file_path']) ?? 'edit';
  const edits = input.edits;
  const candidates = Array.isArray(edits)
    ? edits.map((edit) => editCandidate(edit, fileLabel))
    : [editCandidate(input, fileLabel)];

  const groups = candidates.flatMap((candidate) => {
    if (candidate === undefined) return [];
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
        const marker = line.at(0);
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
  const diffWidth = clampModalWidth(width);
  return diffDisplayLines(hunks, maxHunkLines).flatMap((line) =>
    wrapAnsiToWidth(line.text, diffWidth)
      .split('\n')
      .map((text): DiffDisplayLine => ({ ...line, text })),
  );
}

export function maxDiffScrollOffset(
  totalLines: number,
  maxDisplayLines: number,
): number {
  return maxScrollableRowOffset({
    compactRows: COMPACT_SCROLLABLE_CONTENT_ROWS,
    maxDisplayLines,
    totalLines,
  });
}

/**
 * Start a scrollable approval diff near its first changed visual row. Long
 * wrapped context lines can otherwise consume the whole initial viewport.
 */
export function initialDiffScrollOffset(
  hunks: readonly Hunk[],
  width: number,
  maxDisplayLines: number,
): number {
  if (maxDisplayLines <= COMPACT_SCROLLABLE_CONTENT_ROWS) return 0;

  const lines = wrappedDiffDisplayLines(hunks, width);
  if (lines.length <= maxDisplayLines) return 0;

  const changedIndex = lines.findIndex(
    (line) => line.kind === 'added' || line.kind === 'removed',
  );
  if (changedIndex < 0) return 0;

  const initiallyVisibleContentRows = Math.max(1, maxDisplayLines - 1);
  const firstChange = lines.at(changedIndex);
  const maxOffset = maxDiffScrollOffset(lines.length, maxDisplayLines);
  const defaultOffset = clamp(changedIndex - 1, 0, maxOffset);
  if (firstChange?.kind !== 'removed') {
    return changedIndex < initiallyVisibleContentRows ? 0 : defaultOffset;
  }

  let removedEnd = changedIndex;
  while (lines.at(removedEnd + 1)?.kind === 'removed') removedEnd += 1;
  const addedIndex =
    lines.at(removedEnd + 1)?.kind === 'added' ? removedEnd + 1 : undefined;
  if (addedIndex === undefined) {
    return changedIndex < initiallyVisibleContentRows ? 0 : defaultOffset;
  }

  if (addedIndex < initiallyVisibleContentRows) return 0;

  return clamp(addedIndex - Math.max(1, maxDisplayLines - 2) + 1, 0, maxOffset);
}

function overflowMarkerCandidates(
  kind: OverflowMarkerKind,
  count: number,
): readonly [string, string] {
  switch (kind) {
    case 'hidden':
      return [hiddenRowsText(count), `… ${count} hidden`];
    case 'previous':
      return [previousRowsText(count), `… ${count} prev rows`];
    case 'more':
      return [moreRowsText(count), `… +${count} rows`];
  }
}

function overflowMarkerText(
  kind: OverflowMarkerKind,
  count: number,
  width?: number,
): string {
  const candidates = overflowMarkerCandidates(kind, count);
  if (width === undefined) return candidates[0];

  const markerWidth = clampModalWidth(width);
  return (
    candidates.find(
      (candidate) => textDisplayWidth(candidate) <= markerWidth,
    ) ?? clipToWidth(candidates[1], markerWidth)
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
  const start = clamp(anchor, 0, lines.length - visibleCount);
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
  if (maxDisplayLines <= COMPACT_SCROLLABLE_CONTENT_ROWS) {
    return compactBoundedDiffDisplayLines(lines, maxDisplayLines, width);
  }

  const { hiddenAfter, hiddenBefore, visibleRows } = scrollBoundedRows({
    compactRows: COMPACT_SCROLLABLE_CONTENT_ROWS,
    maxDisplayLines,
    rows: lines,
    scrollOffset,
  });
  return [
    ...(hiddenBefore > 0
      ? [
          {
            kind: 'overflow' as const,
            text: overflowMarkerText('previous', hiddenBefore, width),
          },
        ]
      : []),
    ...visibleRows,
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

interface DiffViewProps {
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
  const width = clampModalWidth(props.width ?? DEFAULT_DIFF_WIDTH);
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

interface DiffLineStyle {
  readonly backgroundColor: string;
  readonly color: string;
}

// Light-background diff band colors: green for additions, rose for removals.
// Both pairs pass WCAG AA contrast at typical terminal font weights (added
// 11.67:1 / APCA Lc 90.2, removed 11.13:1 / Lc 82.8).
//
// On 16-color terminals chalk downsamples both backgrounds to brightWhite and
// both foregrounds to black, so the two bands become visually identical. The
// `+`/`-` marker kept in `line.text` still distinguishes them, so this degrades
// rather than breaks; gating the bands on truecolor support would add a code
// path for a case that already reads correctly.
const DIFF_ADDED_BG = '#dff4e8';
const DIFF_ADDED_FG = '#16351f';
const DIFF_REMOVED_BG = '#f7d9dc';
const DIFF_REMOVED_FG = '#4a171b';

/**
 * Full-width bands for changed lines. Use light backgrounds plus explicit
 * foreground colors so text stays readable on both light and dark terminals.
 * Context lines stay un-banded and dim.
 */
const DIFF_LINE_STYLE: Partial<Record<DiffDisplayLine['kind'], DiffLineStyle>> =
  {
    added: {
      backgroundColor: DIFF_ADDED_BG,
      color: DIFF_ADDED_FG,
    },
    removed: {
      backgroundColor: DIFF_REMOVED_BG,
      color: DIFF_REMOVED_FG,
    },
  };

function DiffLine({
  line,
  width,
}: {
  readonly line: DiffDisplayLine;
  readonly width: number;
}): React.JSX.Element {
  const content = wrapAnsiToWidth(line.text, width);
  const style = DIFF_LINE_STYLE[line.kind];
  if (style) {
    return (
      <Text color={style.color} backgroundColor={style.backgroundColor}>
        {fillRows(content, width)}
      </Text>
    );
  }
  return <Text dimColor>{content}</Text>;
}
