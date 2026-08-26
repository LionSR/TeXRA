import { intlFormatDistance } from 'date-fns';
import prettyBytes from 'pretty-bytes';
import prettyMilliseconds from 'pretty-ms';
import pluralizeWord from 'pluralize';
import { serializeError } from 'serialize-error';

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});

/** Split a string into its grapheme clusters for length-accurate slicing. */
export function toGraphemes(text: string): string[] {
  return [...graphemeSegmenter.segment(text)].map((s) => s.segment);
}

/**
 * Serialize a thrown value into a plain object for logging or transport.
 *
 * Typically called with an `Error`, but any thrown value is accepted —
 * `serialize-error` passes non-`Error` values through and wraps them as
 * needed. Unlike a naive `{ name, message, stack }` copy it also preserves
 * `cause` chains, custom enumerable properties (e.g. `statusCode`,
 * `requestId`), and handles circular references.
 */
export { serializeError };

/** Check if value is a non-empty string after trimming. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Check if value is a string. */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** Floor a millisecond duration down to whole-second granularity. */
function floorToWholeSeconds(durationMs: number): number {
  return Math.floor(durationMs / 1000) * 1000;
}

/**
 * Format a duration in milliseconds to a compact human-readable string
 * (e.g. `3m 42s`, `1h 5m`, `2d 4h`).
 *
 * Backed by `pretty-ms`, so durations spanning hours or days render
 * correctly instead of overflowing into `120min` style output. Durations
 * of one second or more are floored to whole-second granularity, so
 * per-second elapsed displays (e.g. ToolTimer) never report more than the
 * real elapsed time. Sub-second durations render as a `1s` minimum floor
 * (rather than `0s`) to match the prior behavior.
 */
export function formatDuration(durationMs: number): string {
  if (durationMs < 0) return '0s';
  if (durationMs < 1000) return '1s';
  return prettyMilliseconds(floorToWholeSeconds(durationMs), {
    secondsDecimalDigits: 0,
  });
}

/**
 * Compact duration capped at two units (`45s`, `3m 5s`, `1h 1m`).
 *
 * Backed by `pretty-ms` with whole-second flooring like {@link formatDuration},
 * but renders zero / negative / sub-second durations as `0s` (used by elapsed
 * displays that start from zero, e.g. Goal timings and Lean server uptime).
 */
export function formatCompactDuration(durationMs: number): string {
  const wholeSeconds = floorToWholeSeconds(Math.max(0, durationMs));
  if (wholeSeconds === 0) return '0s';
  return prettyMilliseconds(wholeSeconds, {
    secondsDecimalDigits: 0,
    unitCount: 2,
  });
}

/**
 * Format token counts for compact usage displays.
 *
 * Token displays intentionally stay raw until they exceed 4096, the common
 * small-context threshold where an abbreviated number starts buying space. Once
 * k-format rounding would print `1000k`, switch to `M` instead.
 */
export function formatCompactTokenCount(tokens: number): string {
  if (tokens >= 999_500) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens > 4096) return `${Math.round(tokens / 1000)}k`;
  return `${tokens}`;
}

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
  const prefix: string[] = [];

  // Intl.Segmenter is lazy: stop after the first grapheme beyond the budget so
  // truncating a large error or tool payload stays bounded by maxLen.
  for (const { segment } of graphemeSegmenter.segment(text)) {
    if (prefix.length >= maxLen) {
      if (maxLen <= 0) return '…';
      prefix[maxLen - 1] = '…';
      return prefix.join('');
    }
    prefix.push(segment);
  }

  return text;
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
  const graphemes = toGraphemes(text);
  if (graphemes.length <= maxLen) return text;
  // Guard maxLen <= 1: slice(-(1-1)) === slice(-0) === slice(0) would return
  // the whole array, so the ellipsis budget collapses to just "…".
  if (maxLen <= 1) return '…';
  return `…${graphemes.slice(-(maxLen - 1)).join('')}`;
}

/**
 * Format an ISO-8601 timestamp for compact display: normalize to UTC,
 * replace the `T` separator with a space, and drop the fractional-seconds
 * suffix. (e.g. `'2026-06-02T14:30:45.123Z'` → `'2026-06-02 14:30:45'`).
 * Parses through `Date` first so offset forms (e.g. `+02:00`) normalize to
 * UTC instead of passing through unstripped.
 */
export function formatTimestamp(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  const utcIso = Number.isFinite(parsed.getTime())
    ? parsed.toISOString()
    : isoTimestamp;
  return utcIso.replace('T', ' ').replace(/\.\d+Z$/, '');
}

/**
 * Extract the subtype from a MIME type string (e.g. `'wav'` from `'audio/wav'`).
 * A string with no `/` is returned unchanged, since it is already the subtype.
 */
export function extractMimeSubtype(mimeType: string): string {
  return mimeType.split('/').pop() ?? mimeType;
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
 * Format a timestamp (number of ms since epoch, or a date-parsable string) for
 * locale-aware display using the system locale and timezone.
 */
export function formatLocaleTimestamp(ts: number | string): string {
  return new Date(ts).toLocaleString();
}

/**
 * Format an elapsed wall-clock duration as seconds with one decimal digit
 * (e.g. `12.3s`), regardless of magnitude. Unlike {@link formatDuration} /
 * {@link formatCompactDuration}, this never switches to compound units
 * (`2m 5s`) — agent-CLI turn timings are always shown as a single seconds
 * figure.
 */
export function formatWallTimeSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

const SHORT_DATE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Calendar-aware "X ago" / "in X" via Intl.RelativeTimeFormat (handles future timestamps too). */
export function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return '';
  return intlFormatDistance(timestamp, Date.now());
}

/**
 * Formats a date-parsable value as a compact, locale-aware absolute
 * timestamp (short month, no seconds) — the shared "list-item timestamp"
 * shape used across the settingsView History and Memory lists. Returns
 * `null` for missing/invalid input so callers can supply their own fallback
 * copy (e.g. an "Updated: unknown" meta-strip entry).
 */
export function formatShortDateTime(
  value: string | number | Date | null | undefined,
): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return SHORT_DATE_TIME_FORMATTER.format(date);
}

/** Human-readable byte size (binary units, e.g. `1.5 MiB`). */
export function formatBytes(bytes: number): string {
  return prettyBytes(bytes, { binary: true });
}
