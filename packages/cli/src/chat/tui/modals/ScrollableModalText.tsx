// One scrollable text section shared by ConfirmCard approval bodies (bash
// command, delegation prompt, plan objective). Owns wrapping, scroll state,
// bounded slicing with overflow markers, and the scroll KeyHints footer;
// callers own their chrome arithmetic via scrollableModalTextRowsBudget (or
// their own budget for non-bordered layouts) and pass the result as maxRows.

import { useMemo } from 'react';
import { Box, Text } from 'ink';

import { clampModalWidth, MIN_MODAL_CONTENT_WIDTH } from '@cli/tui/ui/theme';
import { wrapAnsiToWidth } from '@cli/tui/ansiWrap';
import { KeyHints } from '@cli/tui/ui/KeyHints';
import { fillRows } from '@cli/runtime/terminalText';
import { confirmCardContentRowsBudget } from './confirmCardRowsBudget';
import {
  boundedScrollableLines,
  compactAwareMaxScrollOffset,
  COMPACT_SCROLLABLE_CONTENT_ROWS,
  scrollPageRows,
  type ScrollableDisplayLine,
} from '../render/scrollBounds';
import { useScrollableOffset } from '../state/useScrollableOffset';

type ModalTextDisplayLine = ScrollableDisplayLine<'text'>;

const DEFAULT_MODAL_TEXT_ROWS = 12;
const SPACIOUS_FIXED_ROWS_EXCLUDING_TITLE = 7;
const COMPACT_FIXED_ROWS_EXCLUDING_TITLE = 5;

/** Rows budget for a text body inside a bordered ConfirmCard. */
export function scrollableModalTextRowsBudget({
  availableRows,
  columns,
  extraFixedRows = 0,
  title,
}: {
  readonly availableRows?: number;
  readonly columns: number;
  /** Modal-specific rows present in both layouts (metadata, feedback…). */
  readonly extraFixedRows?: number;
  readonly title: string;
}): number {
  return confirmCardContentRowsBudget({
    availableRows,
    columns,
    title,
    minContentWidth: MIN_MODAL_CONTENT_WIDTH,
    defaultRows: DEFAULT_MODAL_TEXT_ROWS,
    compactMaxRows: COMPACT_SCROLLABLE_CONTENT_ROWS,
    spaciousFixedRows: SPACIOUS_FIXED_ROWS_EXCLUDING_TITLE,
    compactFixedRows: COMPACT_FIXED_ROWS_EXCLUDING_TITLE,
    extraFixedRows,
  });
}

/**
 * Wrap modal body text to display lines, preserving empty source lines.
 * Prefixes apply per source line (first vs subsequent), e.g. the bash
 * command's `$ ` / `  ` gutter.
 */
export function modalTextDisplayLines({
  continuationPrefix = '',
  firstLinePrefix = '',
  minContentWidth = MIN_MODAL_CONTENT_WIDTH,
  preWrapped = false,
  text,
  trimWrappedLeadingWhitespace = false,
  width,
}: {
  readonly continuationPrefix?: string;
  readonly firstLinePrefix?: string;
  readonly minContentWidth?: number;
  /** The caller already wrapped `text` to `width`. Re-running wrap-ansi over
   *  content that already fits costs a full grapheme-segmentation pass per
   *  render for identical output — worth skipping for a large body that
   *  refreshes as a run streams. */
  readonly preWrapped?: boolean;
  readonly text: string;
  /** Strip leading whitespace on wrap continuations (prose bodies only —
   *  never commands, where quoted whitespace is semantic). */
  readonly trimWrappedLeadingWhitespace?: boolean;
  readonly width: number;
}): ModalTextDisplayLine[] {
  const contentWidth = clampModalWidth(width, minContentWidth);
  return text.split('\n').flatMap((line, index) => {
    const prefixed = `${index === 0 ? firstLinePrefix : continuationPrefix}${line}`;
    const wrapped = ((): readonly string[] => {
      if (prefixed.length === 0) return [''];
      if (preWrapped) return [prefixed];
      return wrapAnsiToWidth(prefixed, contentWidth)
        .split('\n')
        .map((part, partIndex) =>
          trimWrappedLeadingWhitespace && partIndex !== 0
            ? part.trimStart()
            : part,
        );
    })();
    return wrapped.map((part): ModalTextDisplayLine => ({
      kind: 'text',
      text: part,
    }));
  });
}

/** How far the text can scroll within `maxRows` — see useScrollableOffset. */
export function modalTextMaxScrollOffset({
  maxRows,
  totalLines,
}: {
  readonly maxRows: number;
  readonly totalLines: number;
}): number {
  return compactAwareMaxScrollOffset({
    compactRows: COMPACT_SCROLLABLE_CONTENT_ROWS,
    maxDisplayLines: maxRows,
    totalLines,
  });
}

export function boundedModalTextLines({
  hiddenNoun,
  lines,
  maxRows,
  scrollOffset = 0,
  width,
}: {
  readonly hiddenNoun?: string;
  readonly lines: readonly ModalTextDisplayLine[];
  readonly maxRows: number;
  readonly scrollOffset?: number;
  readonly width: number;
}): ModalTextDisplayLine[] {
  return boundedScrollableLines({
    compactRows: COMPACT_SCROLLABLE_CONTENT_ROWS,
    hiddenNoun,
    lines,
    maxDisplayLines: maxRows,
    scrollOffset,
    width,
  });
}

interface ScrollableModalTextProps {
  readonly continuationPrefix?: string;
  readonly firstLinePrefix?: string;
  /** Qualifies single-row overflow markers (e.g. `prompt rows`). */
  readonly hiddenNoun?: string;
  /** Rows granted to the text body — see scrollableModalTextRowsBudget. */
  readonly maxRows: number;
  /** Override the shared modal floor for exceptionally narrow readers. */
  readonly minContentWidth?: number;
  /** Suppress the spacious blank margin (e.g. a metadata row sits above). */
  readonly marginWhenSpacious?: boolean;
  /** Release ↑/↓ while another surface owns them (feedback input). */
  readonly scrollActive?: boolean;
  /** Forwarded to {@link modalTextDisplayLines}: `text` is already wrapped to
   *  `width`, so skip the internal wrap pass. */
  readonly preWrapped?: boolean;
  /** Open at the last line instead of the first. A transcript reads newest-last,
   *  so the rows worth seeing on open are at the bottom. */
  readonly startAtEnd?: boolean;
  /** What counts as "new content" for the purpose of restoring the initial
   *  scroll position. Defaults to the text itself, which is right for a modal
   *  whose body is replaced wholesale. A view over a growing transcript passes
   *  something stabler (the stream id), so appended rows do not yank the
   *  reader back from wherever it scrolled to. */
  readonly resetKey?: unknown;
  /** Suppress the hint row where no row is budgeted for it (compact cards). */
  readonly showScrollHints?: boolean;
  /** ↑/↓ hint verb, e.g. `scroll command`. */
  readonly scrollHint: string;
  readonly text: string;
  readonly trimWrappedLeadingWhitespace?: boolean;
  /** Content width in columns (already inside the card decoration). */
  readonly width: number;
}

export function ScrollableModalText(
  props: ScrollableModalTextProps,
): React.JSX.Element {
  const {
    continuationPrefix,
    firstLinePrefix,
    hiddenNoun,
    marginWhenSpacious,
    maxRows,
    minContentWidth,
    preWrapped,
    resetKey,
    scrollActive,
    scrollHint,
    showScrollHints,
    startAtEnd,
    text,
    trimWrappedLeadingWhitespace,
    width,
  } = props;
  const lines = useMemo(
    () =>
      modalTextDisplayLines({
        continuationPrefix,
        firstLinePrefix,
        minContentWidth,
        preWrapped,
        text,
        trimWrappedLeadingWhitespace,
        width,
      }),
    [
      continuationPrefix,
      firstLinePrefix,
      minContentWidth,
      preWrapped,
      trimWrappedLeadingWhitespace,
      text,
      width,
    ],
  );
  const maxScrollOffset = modalTextMaxScrollOffset({
    maxRows,
    totalLines: lines.length,
  });
  const { scrollOffset, scrollable } = useScrollableOffset({
    active: scrollActive !== false,
    initialOffset: startAtEnd ? maxScrollOffset : 0,
    maxScrollOffset,
    resetKey: resetKey ?? text,
    pageRows: scrollPageRows({
      compactRows: COMPACT_SCROLLABLE_CONTENT_ROWS,
      maxDisplayLines: maxRows,
    }),
  });
  const compactLayout = maxRows <= COMPACT_SCROLLABLE_CONTENT_ROWS;
  const displayLines = boundedModalTextLines({
    hiddenNoun,
    lines,
    maxRows,
    scrollOffset,
    width,
  });
  const contentWidth = clampModalWidth(width, minContentWidth);

  return (
    <>
      <Box
        marginY={
          scrollable || compactLayout || marginWhenSpacious === false ? 0 : 1
        }
        flexDirection="column"
      >
        {displayLines.map((line, index) => (
          <Text key={index} dimColor={line.kind === 'overflow'}>
            {fillRows(line.text, contentWidth)}
          </Text>
        ))}
      </Box>
      {scrollable &&
        maxRows > 1 &&
        scrollActive !== false &&
        showScrollHints !== false && (
          <KeyHints
            confirmCancel={false}
            hints={[
              { key: '↑/↓', action: scrollHint },
              { key: 'PgUp/PgDn', action: 'page' },
            ]}
          />
        )}
    </>
  );
}
