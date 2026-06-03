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

/** Filter null values from an array, narrowing the element type. */
export function filterNotNull<T>(items: (T | null)[]): T[] {
  return items.filter((item): item is T => item !== null);
}

/** Filter null and undefined values from an array, narrowing the element type. */
export function filterNotNullish<T>(items: (T | null | undefined)[]): T[] {
  return items.filter((item): item is T => item != null);
}
