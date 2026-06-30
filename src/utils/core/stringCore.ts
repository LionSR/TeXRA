/** String validation, formatting, duration, token count, and error serialization utilities. */

import prettyMilliseconds from 'pretty-ms';
import { serializeError, type ErrorObject } from 'serialize-error';

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

/** Plain-object shape produced by {@link serializeError}. */
export type SerializedError = ErrorObject;

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
 * Format a percentage value for compact status displays (e.g. `12%`, `12.5%`).
 *
 * Non-finite or non-positive input renders as `0%`, and a positive value below
 * one renders as `<1%` so a tiny-but-present share never reads as `0%`. The
 * `decimals` argument controls the fractional digits of the rendered number
 * (default `0` for whole-percent displays).
 */
export function formatPercent(value: number, decimals = 0): string {
  if (!Number.isFinite(value) || value <= 0) return '0%';
  if (value < 1) return '<1%';
  return `${value.toFixed(decimals)}%`;
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
