/**
 * Shared serialization utilities for converting Map structures to plain objects.
 * These are used throughout the progress view for persistence and webview messaging.
 */

/**
 * Recursively serialize nested Maps to nested Records.
 *
 * @param value - A Map (possibly containing nested Maps) or a leaf value
 * @param depth - Maximum depth to recurse (1 = single Map, 2 = Map of Maps, etc.)
 * @returns Plain object structure with all Maps converted to Records
 *
 * @example
 * // Depth 1: Map → Record
 * mapsToRecords(new Map([['a', 1]]), 1) // { a: 1 }
 *
 * // Depth 2: Map<K, Map<K, V>> → Record<K, Record<K, V>>
 * mapsToRecords(new Map([['run1', new Map([[1, 'v']])]]), 2) // { run1: { '1': 'v' } }
 */
function mapsToRecords(value: unknown, depth: number): unknown {
  if (depth <= 0 || !(value instanceof Map)) {
    return value;
  }
  return Object.fromEntries(
    Array.from((value as Map<unknown, unknown>).entries(), ([k, v]) => [
      String(k),
      mapsToRecords(v, depth - 1),
    ]),
  );
}

/**
 * Serialize a Map to a plain Record object.
 * @example mapToRecord(new Map([['a', 1]])) // { a: 1 }
 */
export function mapToRecord<K extends string | number, V>(
  map: Map<K, V>,
): Record<string, V> {
  return mapsToRecords(map, 1) as Record<string, V>;
}

/**
 * Serialize a nested Map structure (outer → inner → value) to nested Records.
 * Used for run-scoped data like output files by round, usage stats.
 * @example nestedMapToRecord(new Map([['run1', new Map([[1, 'v']])]])) // { run1: { 1: 'v' } }
 */
export function nestedMapToRecord<
  K1 extends string,
  K2 extends string | number,
  V,
>(outer: Map<K1, Map<K2, V>>): Record<string, Record<string, V>> {
  return mapsToRecords(outer, 2) as Record<string, Record<string, V>>;
}

/**
 * Serialize a deeply nested Map (stream → run → round → value).
 * Used for missing outputs tracking which is keyed by stream, then run, then round.
 */
export function tripleNestedMapToRecord<
  K1 extends string,
  K2 extends string,
  K3 extends string | number,
  V,
>(
  outer: Map<K1, Map<K2, Map<K3, V>>>,
): Record<string, Record<string, Record<string, V>>> {
  return mapsToRecords(outer, 3) as Record<
    string,
    Record<string, Record<string, V>>
  >;
}
