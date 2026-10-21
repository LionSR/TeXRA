import prettyBytes from 'pretty-bytes';
import prettyMilliseconds from 'pretty-ms';

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});

/** Check if value is a non-empty string after trimming. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Floor a millisecond duration down to whole-second granularity. */
function floorToWholeSeconds(durationMs: number): number {
  return Math.floor(durationMs / 1000) * 1000;
}

/** Pin `value` into `[min, max]`; `max` wins when the bounds cross. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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

/**
 * Regular English plural of a noun phrase whose head noun is its last word:
 * a consonant + `y` becomes `ies`, a sibilant ending takes `es`, everything
 * else takes `s`. Irregular nouns are not guessed — a caller with one passes
 * `plural` explicitly.
 */
function regularPlural(singular: string): string {
  if (/[^aeiou]y$/i.test(singular)) return `${singular.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh)$/i.test(singular)) return `${singular}es`;
  return `${singular}s`;
}

/** Return the singular or plural form of `singular` based on `count`. */
export function pluralize(
  count: number,
  singular: string,
  plural?: string,
): string {
  if (plural !== undefined) return count === 1 ? singular : plural;
  return count === 1 ? singular : regularPlural(singular);
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
  const lines = text.replaceAll('\r\n', '\n').split('\n');
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

// eslint-disable-next-line no-control-regex -- the C0/C1 control ranges are the match target
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * Replace every C0/C1 control character (tab and newline included) with
 * `replacement`, so untrusted text cannot inject terminal escapes.
 */
export function stripControlCharacters(text: string, replacement = ''): string {
  return text.replaceAll(CONTROL_CHARACTERS, replacement);
}

/**
 * Collapse whitespace first, then truncate to a fixed-width one-line summary.
 */
export function truncateSummary(text: string, maxLength: number): string {
  return truncateWithEllipsis(text.replaceAll(/\s+/g, ' ').trim(), maxLength);
}

/**
 * The shared width for a "here's roughly what this was" preview — a bash
 * command, an agent prompt, a queued follow-up — shown alongside a tool-run
 * or approval summary. Not a hard protocol limit, just the width every such
 * preview in the codebase already converged on.
 */
const PREVIEW_MAX_LENGTH = 60;

/**
 * Truncate `text` to a fixed preview width. Unlike {@link truncateSummary},
 * this does not collapse whitespace first, so a multi-line `text` (an agent
 * prompt, say) keeps its embedded newlines up to the budget — every call
 * site here already passes text that is one line in practice.
 */
export function previewLabel(text: string): string {
  return truncateWithEllipsis(text, PREVIEW_MAX_LENGTH);
}

/**
 * Format a USD cost value as a display string with three decimal places.
 * e.g. `0.012` → `'$0.012'`
 */
export function formatCostUsd(cost: number): string {
  return `$${cost.toFixed(3)}`;
}

const relativeTimeFormat = new Intl.RelativeTimeFormat(undefined, {
  numeric: 'auto',
});
const DAY_MS = 86_400_000;
/** The mean Gregorian year, and a twelfth of it as the month. */
const YEAR_MS = 31_556_952_000;
const MONTH_MS = YEAR_MS / 12;

/**
 * Calendar-aware "X ago" / "in X" (`yesterday`, `last week`, `in 3 hours`),
 * the largest unit the distance fills: seconds, minutes and hours by elapsed
 * time, days and larger by local calendar boundaries, weeks starting Sunday.
 */
export function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return '';
  const format = (value: number, unit: Intl.RelativeTimeFormatUnit) =>
    relativeTimeFormat.format(value, unit);
  const then = new Date(timestamp);
  const now = new Date();
  const ms = timestamp - now.getTime();
  const abs = Math.abs(ms);
  const calendarDay = (d: Date) =>
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;
  const days = calendarDay(then) - calendarDay(now);
  const years = then.getFullYear() - now.getFullYear();
  const quarters =
    years * 4 +
    Math.floor(then.getMonth() / 3) -
    Math.floor(now.getMonth() / 3);

  if (abs < 60_000) return format(Math.trunc(ms / 1000), 'second');
  if (abs < 3_600_000) return format(Math.trunc(ms / 60_000), 'minute');
  if (abs < DAY_MS && days === 0) {
    return format(Math.trunc(ms / 3_600_000), 'hour');
  }
  if (abs < 7 * DAY_MS && days !== 0 && Math.abs(days) < 7) {
    return format(days, 'day');
  }
  if (abs < MONTH_MS) {
    return format((days - then.getDay() + now.getDay()) / 7, 'week');
  }
  if (abs < 3 * MONTH_MS) {
    return format(years * 12 + then.getMonth() - now.getMonth(), 'month');
  }
  if (abs < YEAR_MS && quarters < 4) return format(quarters, 'quarter');
  return format(years, 'year');
}

/** Human-readable byte size in binary units (`1.5 MiB`, `1023 B`). */
export function formatBytes(bytes: number): string {
  return prettyBytes(bytes, { binary: true });
}
