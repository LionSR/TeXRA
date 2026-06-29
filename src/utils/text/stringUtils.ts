import pluralizeWord from 'pluralize';
import safeStringify from 'safe-stable-stringify';

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});

/** Normalize CRLF line endings to LF. */
export function normalizeLineEndings(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/** Return the singular or plural form of `singular` based on `count`. */
export function pluralize(
  count: number,
  singular: string,
  plural?: string,
): string {
  if (plural !== undefined) return count === 1 ? singular : plural;
  return pluralizeWord(singular, count);
}

/**
 * Format a result count with proper pluralization.
 * Example: formatResultCount(3, 'result') returns "3 results"
 */
export function formatResultCount(
  count: number,
  singular: string,
  plural?: string,
): string {
  return `${count} ${pluralize(count, singular, plural)}`;
}

/** UTC calendar date (`YYYY-MM-DD`) of a Date; defaults to now. */
export function isoDateOnly(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function objectToLogString(
  obj: unknown,
  maxLength: number = 1000,
): string {
  // `safe-stable-stringify` never throws on the inputs `JSON.stringify` chokes
  // on: circular references become `"[Circular]"` and BigInt is handled, so a
  // log line keeps its diagnostic value instead of collapsing to the useless
  // `"[object Object]"` that the old `catch (_err) { return String(obj) }`
  // produced. Returns `undefined` only for inputs with no JSON representation
  // (e.g. a bare `undefined`), which we render as the string `"undefined"`.
  const json = safeStringify(obj) ?? String(obj);
  return json.length > maxLength
    ? `${json.slice(0, maxLength)}... (${json.length} chars)`
    : json;
}

/**
 * Normalize line endings and split into content lines.
 * A trailing newline does not produce a phantom empty element.
 *
 * @example
 * splitContentLines('a\nb\nc')   // ['a', 'b', 'c']
 * splitContentLines('a\nb\nc\n') // ['a', 'b', 'c']
 * splitContentLines('')          // []
 */
export function splitContentLines(text: string): string[] {
  if (!text) return [];
  const lines = normalizeLineEndings(text).split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * Count the number of lines in a string.
 * Handles both Unix (\n) and Windows (\r\n) line endings.
 * A trailing newline does not count as an extra line.
 *
 * @example
 * countLines('a\nb\nc') // 3
 * countLines('a\nb\nc\n') // 3 (trailing newline ignored)
 * countLines('') // 0
 */
export function countLines(text: string): number {
  return splitContentLines(text).length;
}

/**
 * Truncate a string to `maxLen` grapheme clusters with a trailing ellipsis (`…`).
 * Returns the original string unchanged if it fits within the limit.
 *
 * Uses `Intl.Segmenter` so multi-codepoint graphemes (ZWJ emoji sequences like
 * 👨‍👩‍👧, combining diacritics, …) are counted and cut as single units — no
 * split surrogates and no torn emoji.
 *
 * @example
 * truncateWithEllipsis('short', 60)           // 'short'
 * truncateWithEllipsis('a very long text', 10) // 'a very lo…'
 */
export function truncateWithEllipsis(text: string, maxLen: number): string {
  const graphemes = [...graphemeSegmenter.segment(text)];
  if (graphemes.length <= maxLen) return text;
  if (maxLen <= 1) return '…';
  return `${graphemes
    .slice(0, maxLen - 1)
    .map((s) => s.segment)
    .join('')}…`;
}

/**
 * Collapse every whitespace run (including newlines) to a single space
 * and trim. Used by header-preview renderers that need a one-line summary
 * of multi-line content.
 *
 * @example
 * collapseWhitespace('foo\n  bar\t baz ') // 'foo bar baz'
 */
export function collapseWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

/**
 * Collapse whitespace first, then truncate to a fixed-width one-line summary.
 */
export function truncateSummary(text: string, maxLength: number): string {
  return truncateWithEllipsis(collapseWhitespace(text), maxLength);
}

/**
 * Keep the last `maxLen` grapheme clusters; prepend an ellipsis when truncated.
 * Complement to `truncateWithEllipsis` for cases where the relevant content
 * is at the end (e.g. terminal installer output where success/error appears last).
 * Like `truncateWithEllipsis`, uses `Intl.Segmenter` so multi-codepoint graphemes
 * are never torn at the cut boundary.
 */
export function tailWithEllipsis(text: string, maxLen: number): string {
  const graphemes = [...graphemeSegmenter.segment(text)];
  if (graphemes.length <= maxLen) return text;
  // Guard maxLen <= 1: slice(-(1-1)) === slice(-0) === slice(0) would return
  // the whole array, so the ellipsis budget collapses to just "…".
  if (maxLen <= 1) return '…';
  return `…${graphemes
    .slice(-(maxLen - 1))
    .map((s) => s.segment)
    .join('')}`;
}

/**
 * Format an ISO-8601 timestamp for compact display: replace the `T`
 * separator with a space and drop the fractional-seconds + `Z` suffix.
 * (e.g. `'2026-06-02T14:30:45.123Z'` → `'2026-06-02 14:30:45'`).
 */
export function formatTimestamp(isoTimestamp: string): string {
  return isoTimestamp.replace('T', ' ').replace(/\.\d+Z$/, '');
}

/**
 * Extract the subtype from a MIME type string (e.g. `'wav'` from `'audio/wav'`).
 * Returns `fallback` (defaults to the original string) when no `/` is found.
 */
export function extractMimeSubtype(
  mimeType: string,
  fallback?: string,
): string {
  return mimeType.split('/').pop() ?? fallback ?? mimeType;
}

/**
 * Join non-empty strings with `sep` (default `'\n'`).
 * Returns `undefined` when no non-empty parts remain, so callers can
 * distinguish "no content" from an empty string.
 */
export function joinNonEmpty(
  parts: string[],
  sep: string = '\n',
): string | undefined {
  const nonempty = parts.filter(Boolean);
  return nonempty.length > 0 ? nonempty.join(sep) : undefined;
}

/**
 * Split command/tool output on newlines, discarding blank lines.
 * Handles both Unix (`\n`) and Windows (`\r\n`) line endings.
 *
 * Prefer this over inline `.split('\n').filter(Boolean)` in command-output
 * parsing so that CRLF line endings from Windows tools are handled uniformly.
 *
 * @example
 * splitOutputLines('foo\nbar\n')     // ['foo', 'bar']
 * splitOutputLines('foo\r\nbar\r\n') // ['foo', 'bar']
 * splitOutputLines('foo\n\nbar')     // ['foo', 'bar']
 * splitOutputLines('')               // []
 */
export function splitOutputLines(text: string): string[] {
  if (!text) return [];
  return normalizeLineEndings(text).split('\n').filter(Boolean);
}

/**
 * Format a USD cost value as a display string with three decimal places.
 * e.g. `0.012` → `'$0.012'`
 */
export function formatCostUsd(cost: number): string {
  return `$${cost.toFixed(3)}`;
}

/**
 * Format a timestamp (number of ms since epoch, or ISO-8601 string) for
 * locale-aware display using the system locale and timezone.
 */
export function formatLocaleTimestamp(ts: number | string): string {
  return new Date(ts).toLocaleString();
}
