// One scrollable text section shared by ConfirmCard approval bodies (bash
// command, delegation prompt, plan objective). Owns wrapping, scroll state,
// bounded slicing with overflow markers, and the scroll KeyHints footer;
// callers own their chrome arithmetic via scrollableModalTextRowsBudget (or
// their own budget for non-bordered layouts) and pass the result as maxRows.

import { useMemo } from 'react';
import { Box, Text } from 'ink';

import { confirmCardContentRowsBudget } from './confirmCardRowsBudget';
import { clampModalWidth, MIN_MODAL_CONTENT_WIDTH } from '../ui/theme';
import { wrapAnsiToWidth } from '../render/ansiWrap';
import {
  boundedScrollableLines,
  compactAwareMaxScrollOffset,
  scrollPageRows,
  type ScrollableDisplayLine,
} from '../render/scrollBounds';
import { fillRows } from '../render/terminalText';
import { KeyHints } from '../ui/KeyHints';
import { useScrollableOffset } from '../state/useScrollableOffset';

export type ModalTextDisplayLine = ScrollableDisplayLine<'text'>;

const DEFAULT_MODAL_TEXT_ROWS = 12;
export const COMPACT_MODAL_TEXT_ROWS = 3;
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
    compactMaxRows: COMPACT_MODAL_TEXT_ROWS,
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
  text,
  width,
}: {
  readonly continuationPrefix?: string;
  readonly firstLinePrefix?: string;
  readonly text: string;
  readonly width: number;
}): ModalTextDisplayLine[] {
  const contentWidth = clampModalWidth(width);
  return text.split('\n').flatMap((line, index) => {
    const prefixed = `${index === 0 ? firstLinePrefix : continuationPrefix}${line}`;
    const wrapped =
      prefixed.length === 0
        ? ['']
        : wrapAnsiToWidth(prefixed, contentWidth)
            .split('\n')
            // Leading whitespace on wrap continuations is a break artifact
            // (e.g. the space after a sentence), not content indentation.
            .map((part, partIndex) =>
              partIndex === 0 ? part : part.trimStart(),
            );
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
    compactRows: COMPACT_MODAL_TEXT_ROWS,
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
    compactRows: COMPACT_MODAL_TEXT_ROWS,
    hiddenNoun,
    lines,
    maxDisplayLines: maxRows,
    scrollOffset,
    width,
  });
}

export interface ScrollableModalTextProps {
  readonly continuationPrefix?: string;
  readonly firstLinePrefix?: string;
  /** Qualifies single-row overflow markers (e.g. `prompt rows`). */
  readonly hiddenNoun?: string;
  /** Rows granted to the text body — see scrollableModalTextRowsBudget. */
  readonly maxRows: number;
  /** Suppress the spacious blank margin (e.g. a metadata row sits above). */
  readonly marginWhenSpacious?: boolean;
  /** ↑/↓ hint verb, e.g. `scroll command`. */
  readonly scrollHint: string;
  readonly text: string;
  /** Content width in columns (already inside the card decoration). */
  readonly width: number;
}

export function ScrollableModalText(
  props: ScrollableModalTextProps,
): React.JSX.Element {
  const { maxRows, text, width } = props;
  const lines = useMemo(
    () =>
      modalTextDisplayLines({
        continuationPrefix: props.continuationPrefix,
        firstLinePrefix: props.firstLinePrefix,
        text,
        width,
      }),
    [props.continuationPrefix, props.firstLinePrefix, text, width],
  );
  const maxScrollOffset = modalTextMaxScrollOffset({
    maxRows,
    totalLines: lines.length,
  });
  const { scrollOffset, scrollable } = useScrollableOffset({
    maxScrollOffset,
    pageRows: scrollPageRows({
      compactRows: COMPACT_MODAL_TEXT_ROWS,
      maxDisplayLines: maxRows,
    }),
  });
  const compactLayout = maxRows <= COMPACT_MODAL_TEXT_ROWS;
  const displayLines = boundedModalTextLines({
    hiddenNoun: props.hiddenNoun,
    lines,
    maxRows,
    scrollOffset,
    width,
  });

  return (
    <>
      <Box
        marginY={
          scrollable || compactLayout || props.marginWhenSpacious === false
            ? 0
            : 1
        }
        flexDirection="column"
      >
        {displayLines.map((line, index) => (
          <Text key={index} dimColor={line.kind === 'overflow'}>
            {fillRows(line.text, clampModalWidth(width))}
          </Text>
        ))}
      </Box>
      {scrollable && maxRows > 1 ? (
        <KeyHints
          confirmCancel={false}
          hints={[
            { key: '↑/↓', action: props.scrollHint },
            { key: 'PgUp/PgDn', action: 'page' },
          ]}
        />
      ) : null}
    </>
  );
}
