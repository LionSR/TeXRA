/**
 * Centralized string validation and transformation utilities.
 *
 * This module provides a single source of truth for common string operations
 * that were previously duplicated across 22+ locations in the codebase.
 *
 * @module stringCore
 */

/**
 * Type guard: Check if value is a non-empty string after trimming.
 *
 * This replaces the common pattern:
 * `typeof x === 'string' && x.trim().length > 0`
 *
 * @param value - The value to check
 * @returns true if value is a string with non-whitespace content
 *
 * @example
 * isNonEmptyString('  hello  ') // true
 * isNonEmptyString('   ')       // false
 * isNonEmptyString(123)         // false
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Type guard: Check if value is a string (including empty).
 *
 * @param value - The value to check
 * @returns true if value is a string
 */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Get trimmed string value or return default.
 *
 * @param value - The value to process
 * @param defaultValue - Value to return if input is not a non-empty string
 * @returns Trimmed string or default value
 *
 * @example
 * getTrimmedOrDefault('  hello  ', 'default') // 'hello'
 * getTrimmedOrDefault('   ', 'default')       // 'default'
 * getTrimmedOrDefault(null, 'default')        // 'default'
 */
export function getTrimmedOrDefault(
  value: unknown,
  defaultValue: string,
): string {
  if (isNonEmptyString(value)) {
    return value.trim();
  }
  return defaultValue;
}

/**
 * Get trimmed string or undefined if empty/invalid.
 *
 * @param value - The value to process
 * @returns Trimmed string or undefined
 *
 * @example
 * getTrimmedOrUndefined('  hello  ') // 'hello'
 * getTrimmedOrUndefined('   ')       // undefined
 */
export function getTrimmedOrUndefined(value: unknown): string | undefined {
  if (isNonEmptyString(value)) {
    return value.trim();
  }
  return undefined;
}

/**
 * Extract error message from various error types.
 *
 * Handles Error objects, strings, and other primitives consistently.
 * Returns trimmed message or undefined if empty.
 *
 * @param err - The error value to extract message from
 * @returns Trimmed error message or undefined
 *
 * @example
 * extractErrorMessage(new Error('  fail  ')) // 'fail'
 * extractErrorMessage('some error')          // 'some error'
 * extractErrorMessage(null)                  // undefined
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
 * Truncate a string if it exceeds a maximum length.
 *
 * @param text - The text to potentially truncate
 * @param maxLength - Maximum allowed length
 * @param suffix - Suffix to append when truncated (default: '...')
 * @returns Original or truncated text
 */
export function truncateString(
  text: string,
  maxLength: number,
  suffix = '...',
): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - suffix.length) + suffix;
}

/**
 * Check if a string contains only whitespace.
 *
 * @param value - The string to check
 * @returns true if string is empty or contains only whitespace
 */
export function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * Normalize whitespace in a string (collapse multiple spaces to single).
 *
 * @param value - The string to normalize
 * @returns String with normalized whitespace
 */
export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Safe string coercion that handles all primitive types.
 *
 * @param value - Any value to convert to string
 * @returns String representation
 */
export function safeToString(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value;
  }
  return String(value);
}
