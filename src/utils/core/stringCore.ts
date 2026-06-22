/**
 * String validation, formatting, and error extraction utilities.
 *
 * ## Error Utility Guide
 *
 * This module provides low-level error utilities. For higher-level error handling,
 * see `@common/errors`.
 *
 * | Function | Returns | Use Case |
 * |----------|---------|----------|
 * | `extractErrorMessage(err)` | `string \| undefined` | Optional extraction, returns undefined for non-errors |
 * | `serializeError(err)` | `SerializedError` | Convert Error to plain object for logging/transport |
 *
 * For guaranteed string conversion, use `toErrorMessage()` from `@utils/core`.
 */

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

/**
 * Extract error message from Error objects or strings.
 * Returns undefined if the value is not an Error or non-empty string.
 *
 * Use this when you need optional extraction. For guaranteed string output,
 * use `toErrorMessage()` from `@utils/core`.
 */
export function extractErrorMessage(err: unknown): string | undefined {
  if (err instanceof Error && isNonEmptyString(err.message)) {
    return err.message.trim();
  }
  if (isNonEmptyString(err)) {
    return err.trim();
  }
  return undefined;
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
  const wholeSeconds = Math.floor(durationMs / 1000) * 1000;
  return prettyMilliseconds(wholeSeconds, { secondsDecimalDigits: 0 });
}

/**
 * Compact duration capped at two units (`45s`, `3m 5s`, `1h 1m`).
 *
 * Backed by `pretty-ms` with whole-second flooring like {@link formatDuration},
 * but renders zero / negative / sub-second durations as `0s` (used by elapsed
 * displays that start from zero, e.g. Goal timings and Lean server uptime).
 */
export function formatCompactDuration(durationMs: number): string {
  const wholeSeconds = Math.floor(Math.max(0, durationMs) / 1000) * 1000;
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
