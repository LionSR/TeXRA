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
