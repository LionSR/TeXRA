/**
 * Type guards for common value structures.
 */

/** Check if value is a non-null object (not array). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Check if value is a finite number (excludes NaN and ±Infinity). */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Predicate for filtering null values from arrays while narrowing the element type. */
export function filterNotNull<T>(item: T | null): item is T {
  return item !== null;
}

/** Predicate for filtering null and undefined values from arrays while narrowing the element type. */
export function filterNotNullish<T>(item: T | null | undefined): item is T {
  return item != null;
}
