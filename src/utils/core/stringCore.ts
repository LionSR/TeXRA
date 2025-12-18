/**
 * String validation and error extraction utilities.
 *
 * ## Error Utility Guide
 *
 * This module provides low-level error utilities. For higher-level error handling,
 * see `@common/errors/errorHandlingUtils`.
 *
 * | Function | Returns | Use Case |
 * |----------|---------|----------|
 * | `extractErrorMessage(err)` | `string \| undefined` | Optional extraction, returns undefined for non-errors |
 * | `serializeError(err)` | `SerializedError` | Convert Error to plain object for logging/transport |
 *
 * For guaranteed string conversion, use `toErrorMessage()` from `@common/errors/errorHandlingUtils`.
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
 * Extract error message from Error objects or strings.
 * Returns undefined if the value is not an Error or non-empty string.
 *
 * Use this when you need optional extraction. For guaranteed string output,
 * use `toErrorMessage()` from `@common/errors/errorHandlingUtils`.
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
