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
 * For guaranteed string conversion, use `toErrorMessage()` from `@common/errors`.
 */

import prettyMilliseconds from 'pretty-ms';
import { serializeError, type ErrorObject } from 'serialize-error';

/**
 * Serialize an Error into a plain object for logging or transport.
 *
 * Backed by the `serialize-error` package, which (unlike a naive
 * `{ name, message, stack }` copy) preserves `cause` chains, custom
 * properties (e.g. `statusCode`, `requestId`), and handles circular
 * references and non-Error throws.
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
 * Escape regular-expression metacharacters in a literal string so it can be
 * embedded inside a dynamic RegExp without special interpretation.
 */
export function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract error message from Error objects or strings.
 * Returns undefined if the value is not an Error or non-empty string.
 *
 * Use this when you need optional extraction. For guaranteed string output,
 * use `toErrorMessage()` from `@common/errors`.
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
 * correctly instead of overflowing into `120min` style output. Sub-second
 * durations floor to `1s` and the input is truncated to whole-second
 * granularity so per-second elapsed displays (e.g. ToolTimer) never tick
 * ahead of the real elapsed time.
 */
export function formatDuration(durationMs: number): string {
  if (durationMs < 0) return '0s';
  if (durationMs < 1000) return '1s';
  const wholeSeconds = Math.floor(durationMs / 1000) * 1000;
  return prettyMilliseconds(wholeSeconds, { secondsDecimalDigits: 0 });
}
