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

/** Format duration in milliseconds to human-readable string (e.g. "3min, 42sec"). */
export function formatDuration(durationMs: number): string {
  if (durationMs < 0) return '0s';
  if (durationMs < 1000) return '1s';

  const seconds = Math.floor(durationMs / 1000) % 60;
  const minutes = Math.floor(durationMs / (1000 * 60));

  if (minutes === 0) return `${seconds}sec`;
  if (seconds === 0) return `${minutes}min`;
  return `${minutes}min, ${seconds}sec`;
}

/** Serialized error object shape. */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

/**
 * Serialize an Error object to a plain object for logging or transport.
 * Returns a structured object with name, message, and optional stack.
 */
export function serializeError(err: Error): SerializedError {
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };
}
