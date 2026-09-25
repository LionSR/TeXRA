// Unified-diff renderer for edit-approval modals + tool cards: `diff` hunks
// render line by line as full-width added/removed bands with dim context rows
// (see DIFF_LINE_STYLE for the color rationale).

import { Box, Text } from 'ink';

import { fillRows } from '@cli/runtime/terminalText';
import { wrapAnsiToWidth } from '@cli/tui/ansiWrap';
import { clampModalWidth } from '@cli/tui/ui/theme';
import { clamp } from '@utils/core';
import { formatHunkHeader } from '@utils/text/unifiedDiff';

import {
  boundedScrollableLines,
  COMPACT_SCROLLABLE_CONTENT_ROWS,
  compactAwareMaxScrollOffset,
  type ScrollableDisplayLine,
} from './scrollBounds';
import type { StructuredPatchHunk } from 'diff';

type Hunk = StructuredPatchHunk;

export interface InlinePatchGroup {
  readonly fileLabel: string;
  readonly hunks: readonly Hunk[];
}

type DiffDisplayLine = ScrollableDisplayLine<
  'added' | 'context' | 'header' | 'removed'
>;

const NO_NEWLINE_MARKER = '\\';
const DEFAULT_DIFF_WIDTH = 74;

export function diffDisplayLines(hunks: readonly Hunk[]): DiffDisplayLine[] {
  return hunks.flatMap((hunk) => [
    { kind: 'header' as const, text: formatHunkHeader(hunk) },
    ...hunk.lines
      .filter((line) => !line.startsWith(NO_NEWLINE_MARKER))
      .map((line): DiffDisplayLine => {
        const marker = line.at(0);
        if (marker === '+') return { kind: 'added', text: line };
        if (marker === '-') return { kind: 'removed', text: line };
        return { kind: 'context', text: line };
      }),
  ]);
}

export function wrappedDiffDisplayLines(
  hunks: readonly Hunk[],
  width: number,
): DiffDisplayLine[] {
  const diffWidth = clampModalWidth(width);
  return diffDisplayLines(hunks).flatMap((line) =>
    wrapAnsiToWidth(line.text, diffWidth)
      .split('\n')
      .map((text): DiffDisplayLine => ({ ...line, text })),
  );
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
  const lines = wrappedDiffDisplayLines(hunks, width);
  if (lines.length <= maxDisplayLines) return 0;
  if (maxDisplayLines <= COMPACT_SCROLLABLE_CONTENT_ROWS) {
    return representativeDiffLineIndex(lines);
  }

  const changedIndex = lines.findIndex(
    (line) => line.kind === 'added' || line.kind === 'removed',
  );
  if (changedIndex < 0) return 0;

  const initiallyVisibleContentRows = Math.max(1, maxDisplayLines - 1);
  const firstChange = lines.at(changedIndex);
  const maxOffset = compactAwareMaxScrollOffset({
    maxDisplayLines,
    totalLines: lines.length,
  });
  const defaultOffset = clamp(changedIndex - 1, 0, maxOffset);
  const fallbackOffset = (): number =>
    changedIndex < initiallyVisibleContentRows ? 0 : defaultOffset;
  if (firstChange?.kind !== 'removed') {
    return fallbackOffset();
  }

  let removedEnd = changedIndex;
  while (lines.at(removedEnd + 1)?.kind === 'removed') removedEnd += 1;
  const addedIndex =
    lines.at(removedEnd + 1)?.kind === 'added' ? removedEnd + 1 : undefined;
  if (addedIndex === undefined) {
    return fallbackOffset();
  }

  if (addedIndex < initiallyVisibleContentRows) return 0;

  return clamp(addedIndex - Math.max(1, maxDisplayLines - 2) + 1, 0, maxOffset);
}

// Compact windows cannot scroll far enough to find the edit, so they anchor on
// the first changed row (or the first content row when nothing changed).
function representativeDiffLineIndex(
  lines: readonly DiffDisplayLine[],
): number {
  const changedIndex = lines.findIndex(
    (line) => line.kind === 'added' || line.kind === 'removed',
  );
  return Math.max(0, changedIndex);
}

/** Wrapped diff lines bounded to `maxDisplayLines`; 0 = no truncation. An
 *  omitted `scrollOffset` anchors compact windows on the first change. */
export function scrollBoundedDiffDisplayLines(
  hunks: readonly Hunk[],
  maxDisplayLines: number,
  scrollOffset: number | undefined,
  width: number,
): DiffDisplayLine[] {
  const lines = wrappedDiffDisplayLines(hunks, width);
  return boundedScrollableLines({
    lines,
    maxDisplayLines,
    scrollOffset:
      scrollOffset ??
      (maxDisplayLines <= COMPACT_SCROLLABLE_CONTENT_ROWS
        ? representativeDiffLineIndex(lines)
        : 0),
    width: clampModalWidth(width),
  });
}

interface DiffViewProps {
  readonly hunks: readonly Hunk[];
  /** Maximum total rendered diff rows before truncating; 0 = no truncation. */
  readonly maxDisplayLines?: number;
  /** Starting diff row when maxDisplayLines truncates the display. */
  readonly scrollOffset?: number;
  readonly width?: number;
}

export function DiffView(props: DiffViewProps): React.JSX.Element {
  const maxDisplayLines = props.maxDisplayLines ?? 0;
  const width = clampModalWidth(props.width ?? DEFAULT_DIFF_WIDTH);
  const lines = scrollBoundedDiffDisplayLines(
    props.hunks,
    maxDisplayLines,
    props.scrollOffset,
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
  // Every line reaching here already came through `wrappedDiffDisplayLines`
  // (or the width-clipped overflow marker), and `clampModalWidth` is
  // idempotent, so a second wrap could not split anything.
  const style = DIFF_LINE_STYLE[line.kind];
  if (style) {
    return (
      <Text color={style.color} backgroundColor={style.backgroundColor}>
        {fillRows(line.text, width)}
      </Text>
    );
  }
  return <Text dimColor>{line.text}</Text>;
}
