/**
 * Reusable sort comparator functions for use with Array.sort / Array.toSorted.
 */

/** Alphabetically compare two objects by their `name` property. */
export function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name);
}
