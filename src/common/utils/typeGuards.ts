/**
 * Common type guards and validation utilities shared across the codebase.
 * These utilities help eliminate repetitive type checking patterns.
 */

/**
 * Type guard to check if a value is a plain object (not null, not array)
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Type guard to check if a value is a non-empty string
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Type guard to check if a value is a valid object with specific properties
 */
export function hasProperties<T extends Record<string, unknown>>(
  value: unknown,
  properties: Array<keyof T>,
): value is T {
  if (!isPlainObject(value)) {
    return false;
  }
  return properties.every((prop) => prop in value);
}

/**
 * Validates that a value is a string, returning it or null
 */
export function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Validates that a value is an object, returning it or null
 */
export function asObjectOrNull<T extends Record<string, unknown>>(
  value: unknown,
): T | null {
  return isPlainObject(value) ? (value as T) : null;
}
