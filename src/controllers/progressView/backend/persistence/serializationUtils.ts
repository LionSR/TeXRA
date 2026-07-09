/**
 * Shared serialization utilities for converting Map structures to Record
 * objects before JSON serialization.
 */

/**
 * Serialize a Map to a plain Record object. Keys are stringified.
 * @example mapToRecord(new Map([['a', 1]])) // { a: 1 }
 */
export function mapToRecord<K extends string | number, V>(
  map: Map<K, V>,
): Record<string, V> {
  return Object.fromEntries(Array.from(map, ([k, v]) => [String(k), v]));
}
