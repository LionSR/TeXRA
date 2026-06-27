/**
 * Reusable sort comparator functions for use with Array.sort / Array.toSorted.
 */

/** Alphabetically compare two objects by their `name` property. */
export function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name);
}

/** Alphabetically compare two strings directly — pass as `.sort(byString)`. */
export function byString(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * Build a comparator that alphabetically sorts objects by a derived string.
 * @example `.sort(byStringProp(t => t.path))`
 */
export function byStringProp<T>(fn: (t: T) => string): (a: T, b: T) => number {
  return (a, b) => fn(a).localeCompare(fn(b));
}

/**
 * Return a new array ordered by newest timestamp first.
 * Each timestamp is parsed once before sorting.
 */
export function toNewestFirstByTimestamp<T>(
  items: readonly T[],
  timestampOf: (item: T) => string,
): T[] {
  return items
    .map((item) => ({ item, key: Date.parse(timestampOf(item)) }))
    .sort((a, b) => b.key - a.key)
    .map(({ item }) => item);
}
