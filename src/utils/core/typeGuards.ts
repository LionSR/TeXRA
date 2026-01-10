/**
 * Type guards for common value structures.
 */

/** Check if value is a non-null object (not array). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
