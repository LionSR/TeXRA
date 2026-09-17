import cliTruncate from 'cli-truncate';
import sliceAnsi from 'slice-ansi';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';

import { collapseWhitespace } from '@utils/text/stringUtils';

const UNSAFE_TERMINAL_CONTROLS =
  // eslint-disable-next-line no-control-regex -- terminal output must exclude C0/C1 controls
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** Remove terminal control sequences while preserving printable text and line breaks. */
export function safeTerminalText(text: string): string {
  return stripAnsi(text)
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\t', '  ')
    .replaceAll(UNSAFE_TERMINAL_CONTROLS, '');
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

/**
 * Normalize a reported terminal width into whole usable columns.
 *
 * A width that is absent or non-finite is unknown, so `fallback` stands in for
 * it — pass `undefined` to let "unknown" propagate to the caller instead. The
 * resolved width is then floored, reduced by `inset` (gutters the caller
 * already owns), and finally clamped up to `min`.
 *
 * The order is load-bearing: flooring after the inset would let a fractional
 * width survive it, and clamping before it would let a wide inset push the
 * result back under `min`. `fallback` goes through the same pipeline as a real
 * width, so a caller's inset applies to it too.
 */
export function terminalColumns<Fallback extends number | undefined>({
  width,
  fallback,
  min,
  inset = 0,
}: {
  readonly width: number | undefined;
  readonly fallback: Fallback;
  readonly min: number;
  readonly inset?: number;
}): number | Fallback {
  const resolved = width != null && Number.isFinite(width) ? width : fallback;
  if (resolved === undefined) return fallback;
  return Math.max(min, Math.floor(resolved) - inset);
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
