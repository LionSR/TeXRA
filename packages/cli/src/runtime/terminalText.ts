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

/** Pad each visual row to `width` display columns. */
export function fillRows(text: string, width: number): string {
  return text
    .split('\n')
    .map((row) => row + ' '.repeat(Math.max(0, width - textDisplayWidth(row))))
    .join('\n');
}
