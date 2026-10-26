// Unified-diff renderer for edit-approval modals + tool cards: `diff` hunks
// render line by line as full-width added/removed bands with dim context rows
// (see DIFF_LINE_STYLE for the color rationale).

import { Number as Num } from 'effect';
import { Box, Text } from 'ink';

import {
  formatHunkLines,
  type ToolEditContent,
} from '@texra-ai/harness/schemas';
import { fillRows, safeTerminalText } from '@cli/runtime/terminalText';
import { wrapAnsiToWidth } from '@cli/tui/ansiWrap';
import { clampModalWidth } from '@cli/tui/ui/theme';

import {
  boundedScrollableLines,
  COMPACT_SCROLLABLE_CONTENT_ROWS,
  compactAwareMaxScrollOffset,
  type ScrollableDisplayLine,
} from './scrollBounds';

type Hunk = ToolEditContent['hunks'][number];

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
  return formatHunkLines(hunks)
    .filter((line) => !line.startsWith(NO_NEWLINE_MARKER))
    .map((raw): DiffDisplayLine => {
      // A hunk line starts with its marker, so only a header starts `@@`.
      if (raw.startsWith('@@')) return { kind: 'header', text: raw };
      // File text is producer text: strip what a terminal would execute.
      // A patch line is one row, so a CR (a CRLF file) opens no new one.
      const line = safeTerminalText(raw).replaceAll('\n', '');
      const marker = line.at(0);
      if (marker === '+') return { kind: 'added', text: line };
      if (marker === '-') return { kind: 'removed', text: line };
      return { kind: 'context', text: line };
    });
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
  const defaultOffset = Num.clamp(changedIndex - 1, {
    minimum: 0,
    maximum: maxOffset,
  });
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

  const windowRows = Math.max(1, maxDisplayLines - 2);
  let addedEnd = addedIndex;
  while (lines.at(addedEnd + 1)?.kind === 'added') addedEnd += 1;
  if (addedEnd - changedIndex + 1 > windowRows) {
    // The replacement is taller than the window (a long line wrapped over
    // several rows): open on the first new row that differs from its old
    // counterpart, one row of the new text above it, so the edit itself
    // shows rather than the rows it left alone.
    let differs = 0;
    while (
      addedIndex + differs < addedEnd &&
      changedIndex + differs < removedEnd &&
      lines.at(addedIndex + differs)?.text.slice(differs === 0 ? 1 : 0) ===
        lines.at(changedIndex + differs)?.text.slice(differs === 0 ? 1 : 0)
    ) {
      differs += 1;
    }
    const edited = addedIndex + differs;
    if (edited < initiallyVisibleContentRows) return 0;
    return Num.clamp(edited - 1, { minimum: 0, maximum: maxOffset });
  }

  if (addedIndex < initiallyVisibleContentRows) return 0;
  return Num.clamp(addedIndex - windowRows + 1, {
    minimum: 0,
    maximum: maxOffset,
  });
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
 *  omitted `scrollOffset` anchors compact windows on the first change.
 *  `width` is already clamped by the `DiffView` entry point. */
function scrollBoundedDiffDisplayLines(
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
    width,
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
//
// Full-width bands for changed lines: light backgrounds plus explicit
// foreground colors so text stays readable on both light and dark terminals.
// Context lines stay un-banded and dim.
const DIFF_LINE_STYLE: Partial<Record<DiffDisplayLine['kind'], DiffLineStyle>> =
  {
    added: { backgroundColor: '#dff4e8', color: '#16351f' },
    removed: { backgroundColor: '#f7d9dc', color: '#4a171b' },
  };

function DiffLine({
  line,
  width,
}: {
  readonly line: DiffDisplayLine;
  readonly width: number;
}): React.JSX.Element {
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
