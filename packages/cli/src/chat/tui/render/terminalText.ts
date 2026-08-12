import cliTruncate from 'cli-truncate';
import sliceAnsi from 'slice-ansi';
import stringWidth from 'string-width';

import { collapseWhitespace } from '@utils/text/stringUtils';

export function textDisplayWidth(text: string): number {
  return stringWidth(text);
}

function normalizeColumns(width: number): number {
  if (!Number.isFinite(width)) {
    throw new TypeError('Terminal width must be finite.');
  }
  return Math.max(0, Math.floor(width));
}

/** Hard-clip to `width` display columns with no ellipsis. */
export function clipToWidth(text: string, width: number): string {
  return sliceAnsi(text, 0, normalizeColumns(width));
}

/** Truncate to `maxColumns` display columns, ending with `…` when cut. */
export function truncateToWidth(text: string, maxColumns: number): string {
  return cliTruncate(text, normalizeColumns(maxColumns));
}

/** Collapse whitespace, then truncate — the one-line-summary form used by
 *  status rows and side panels. */
export function truncateSummaryToWidth(
  text: string,
  maxColumns: number,
): string {
  return truncateToWidth(collapseWhitespace(text), maxColumns);
}

/**
 * Pad every visual row out to `width` display columns.
 *
 * Ink only paints backgrounds and inverse-video spans behind glyphs it draws,
 * so padding extends bands across the full row. `textDisplayWidth` keeps wide
 * glyphs and emoji aligned.
 */
export function fillRows(text: string, width: number): string {
  return text
    .split('\n')
    .map((row) => row + ' '.repeat(Math.max(0, width - textDisplayWidth(row))))
    .join('\n');
}
