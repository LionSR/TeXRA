import cliTruncate from 'cli-truncate';
import sliceAnsi from 'slice-ansi';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';

import {
  collapseWhitespace,
  stripControlCharacters,
} from '@utils/text/stringUtils';

/** Remove terminal control sequences while preserving printable text and line breaks. */
export function safeTerminalText(text: string): string {
  return stripAnsi(text)
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\t', '  ')
    .split('\n')
    .map((line) => stripControlCharacters(line))
    .join('\n');
}

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

/** Collapse whitespace, then truncate to a terminal-column budget. */
export function truncateSummaryToWidth(
  text: string,
  maxColumns: number,
): string {
  return truncateToWidth(collapseWhitespace(text), maxColumns);
}

/**
 * Widest-first layout cascade: the first candidate whose measured width fits
 * `maxColumns` wins, `fallback` when none does. `false`/`undefined` entries are
 * inapplicable layouts left in place, so a candidate list still reads top to
 * bottom as "this layout, else this one". An undefined `maxColumns` — an
 * unknown terminal width, as in tests and headless runs — fits everything.
 */
export function firstFittingCandidate<T>({
  candidates,
  fallback,
  maxColumns,
  measure,
}: {
  readonly candidates: readonly (T | false | undefined)[];
  readonly fallback: T;
  readonly maxColumns: number | undefined;
  readonly measure: (candidate: T) => number;
}): T {
  for (const candidate of candidates) {
    if (candidate === false || candidate === undefined) continue;
    if (maxColumns === undefined || measure(candidate) <= maxColumns) {
      return candidate;
    }
  }
  return fallback;
}

/** Pad each visual row to `width` display columns. */
export function fillRows(text: string, width: number): string {
  return text
    .split('\n')
    .map((row) => row + ' '.repeat(Math.max(0, width - textDisplayWidth(row))))
    .join('\n');
}
