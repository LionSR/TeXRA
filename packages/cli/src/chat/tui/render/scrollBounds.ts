import { clipToWidth, textDisplayWidth } from '@cli/runtime/terminalText';
import {
  hiddenRowsText,
  moreRowsText,
  previousRowsText,
  scrollStatusText,
} from '@cli/tui/overflowText';
import { clamp } from '@utils/core';

/**
 * Below this many content rows, a scrollable region degrades to a single
 * status/overflow row instead of scrolling (a compact layout). The single
 * source of truth for the threshold every scroll-bounds caller uses as its
 * `compactRows` — the modal text body, the external-inquiry question, and the
 * approval diff all share this one concept.
 */
export const COMPACT_SCROLLABLE_CONTENT_ROWS = 3;

interface ScrollBoundedRows<T> {
  readonly hiddenAfter: number;
  readonly hiddenBefore: number;
  readonly visibleRows: readonly T[];
}

// Shared by both offset functions below: with one row reserved (for an
// overflow marker or scroll-status row), how far content can scroll.
function maxOffsetReservingOneRow(
  maxDisplayLines: number,
  totalLines: number,
): number {
  return Math.max(0, totalLines - Math.max(1, maxDisplayLines - 1));
}

export function maxScrollableRowOffset({
  compactRows,
  maxDisplayLines,
  totalLines,
}: {
  readonly compactRows: number;
  readonly maxDisplayLines: number;
  readonly totalLines: number;
}): number {
  if (maxDisplayLines <= compactRows || totalLines <= maxDisplayLines) {
    return 0;
  }
  return maxOffsetReservingOneRow(maxDisplayLines, totalLines);
}

export function scrollBoundedRows<T>({
  compactRows,
  maxDisplayLines,
  rows,
  scrollOffset = 0,
}: {
  readonly compactRows: number;
  readonly maxDisplayLines: number;
  readonly rows: readonly T[];
  readonly scrollOffset?: number;
}): ScrollBoundedRows<T> {
  if (maxDisplayLines <= 0 || rows.length <= maxDisplayLines) {
    return { hiddenAfter: 0, hiddenBefore: 0, visibleRows: rows };
  }

  if (maxDisplayLines <= compactRows) {
    // maxDisplayLines > 0 here (the early return above rules out <= 0).
    const visibleRows = rows.slice(0, maxDisplayLines);
    return {
      hiddenAfter: Math.max(0, rows.length - visibleRows.length),
      hiddenBefore: 0,
      visibleRows,
    };
  }

  const offset = Math.max(
    0,
    Math.min(
      scrollOffset,
      maxScrollableRowOffset({
        compactRows,
        maxDisplayLines,
        totalLines: rows.length,
      }),
    ),
  );
  const hiddenBefore = offset;
  const reserveBefore = hiddenBefore > 0 ? 1 : 0;
  const contentSlotsWithoutAfter = Math.max(0, maxDisplayLines - reserveBefore);
  const reserveAfter = offset + contentSlotsWithoutAfter < rows.length ? 1 : 0;
  const visibleCount = Math.max(
    0,
    maxDisplayLines - reserveBefore - reserveAfter,
  );
  const visibleRows = rows.slice(offset, offset + visibleCount);
  const hiddenAfter = Math.max(0, rows.length - (offset + visibleCount));

  return { hiddenAfter, hiddenBefore, visibleRows };
}

/** A renderable line that is either real content or an overflow marker row. */
export interface ScrollableDisplayLine<K extends string = string> {
  readonly kind: K | 'overflow';
  readonly text: string;
}

/**
 * Maximum scroll offset for a region that degrades to a single status row in
 * compact layouts: below `compactRows` the last visible row is reserved for
 * the overflow marker, so content scrolls within `maxDisplayLines - 1` rows.
 */
export function compactAwareMaxScrollOffset({
  compactRows,
  maxDisplayLines,
  totalLines,
}: {
  readonly compactRows: number;
  readonly maxDisplayLines: number;
  readonly totalLines: number;
}): number {
  if (maxDisplayLines <= 0) return 0;
  if (maxDisplayLines <= compactRows && totalLines > maxDisplayLines) {
    return maxOffsetReservingOneRow(maxDisplayLines, totalLines);
  }

  return maxScrollableRowOffset({ compactRows, maxDisplayLines, totalLines });
}

/** Rows advanced by PgUp/PgDn, leaving a row of context where space allows. */
export function scrollPageRows({
  compactRows,
  maxDisplayLines,
}: {
  readonly compactRows: number;
  readonly maxDisplayLines: number;
}): number {
  return maxDisplayLines <= compactRows
    ? Math.max(1, maxDisplayLines - 1)
    : Math.max(1, maxDisplayLines - 2);
}

function compactHiddenLineText({
  firstLine,
  hiddenNoun,
  hiddenLines,
  width,
}: {
  readonly firstLine: string;
  readonly hiddenNoun: string | undefined;
  readonly hiddenLines: number;
  readonly width: number;
}): string {
  const hiddenText = hiddenRowsText(hiddenLines, hiddenNoun);
  const suffix = ` ${hiddenText}`;
  const prefixWidth = width - textDisplayWidth(suffix);
  if (prefixWidth <= 0) return clipToWidth(hiddenText, width);

  const prefix = clipToWidth(firstLine, prefixWidth).trimEnd();
  if (prefix.length === 0) return clipToWidth(hiddenText, width);

  return `${prefix}${suffix}`;
}

/**
 * Bounds pre-wrapped display lines to `maxDisplayLines`, replacing hidden
 * spans with overflow marker rows. Compact layouts reserve the last row for a
 * combined scroll-status marker; a single-row budget collapses to one
 * "first line ... N {hiddenNoun} hidden" row.
 */
export function boundedScrollableLines<K extends string>({
  compactRows,
  hiddenNoun,
  lines,
  maxDisplayLines,
  scrollOffset = 0,
  width,
}: {
  readonly compactRows: number;
  /** Qualifies what is hidden in single-row markers (e.g. `prompt rows`). */
  readonly hiddenNoun?: string;
  readonly lines: readonly ScrollableDisplayLine<K>[];
  readonly maxDisplayLines: number;
  readonly scrollOffset?: number;
  readonly width: number;
}): ScrollableDisplayLine<K>[] {
  if (maxDisplayLines <= 0 || lines.length <= maxDisplayLines) {
    return [...lines];
  }

  const maxOffset = compactAwareMaxScrollOffset({
    compactRows,
    maxDisplayLines,
    totalLines: lines.length,
  });

  if (maxDisplayLines <= compactRows) {
    const contentRows = Math.max(1, maxDisplayLines - 1);
    const offset = clamp(scrollOffset, 0, maxOffset);

    if (maxDisplayLines === 1) {
      return [
        {
          kind: 'overflow',
          text: compactHiddenLineText({
            firstLine: lines[offset]?.text ?? '',
            hiddenNoun,
            hiddenLines: lines.length - 1,
            width,
          }),
        },
      ];
    }

    const visible = lines.slice(offset, offset + contentRows);
    const hiddenBefore = offset;
    const hiddenAfter = Math.max(0, lines.length - (offset + visible.length));
    return [
      ...visible,
      {
        kind: 'overflow',
        text: clipToWidth(scrollStatusText(hiddenBefore, hiddenAfter), width),
      },
    ];
  }

  const { hiddenAfter, hiddenBefore, visibleRows } = scrollBoundedRows({
    compactRows,
    maxDisplayLines,
    rows: lines,
    scrollOffset,
  });

  return [
    ...(hiddenBefore > 0
      ? [
          {
            kind: 'overflow' as const,
            text: previousRowsText(hiddenBefore),
          },
        ]
      : []),
    ...visibleRows,
    ...(hiddenAfter > 0
      ? [{ kind: 'overflow' as const, text: moreRowsText(hiddenAfter) }]
      : []),
  ];
}
