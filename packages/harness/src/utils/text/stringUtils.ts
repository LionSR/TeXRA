import prettyMilliseconds from 'pretty-ms';

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});

/** Floor a millisecond duration down to whole-second granularity. */
function floorToWholeSeconds(durationMs: number): number {
  return Math.floor(durationMs / 1000) * 1000;
}

/**
 * Compact duration capped at two units (`45s`, `3m 5s`, `1h 1m`).
 *
 * Backed by `pretty-ms` with whole-second flooring,
 * but renders zero / negative / sub-second durations as `0s` (used by elapsed
 * displays that start from zero, e.g. goal timings and server uptime).
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
