/**
 * Shared serialization utilities for converting Map structures to plain objects.
 * These are used throughout the progress view for persistence and webview messaging.
 */

/**
 * Serialize a Map to a plain Record object.
 * @example mapToRecord(new Map([['a', 1]])) // { a: 1 }
 */
export function mapToRecord<K extends string | number, V>(
  map: Map<K, V>,
): Record<string, V> {
  return Object.fromEntries(map.entries()) as Record<string, V>;
}

/**
 * Serialize a nested Map structure (outer → inner → value) to nested Records.
 * Used for run-scoped data like output files by round, usage stats.
 * @example nestedMapToRecord(new Map([['run1', new Map([[1, 'v']])]])) // { run1: { 1: 'v' } }
 */
export function nestedMapToRecord<K1 extends string, K2 extends string | number, V>(
  outer: Map<K1, Map<K2, V>>,
): Record<string, Record<string, V>> {
  return Object.fromEntries(
    Array.from(outer.entries(), ([key, inner]) => [
      key,
      Object.fromEntries(inner.entries()),
    ]),
  ) as Record<string, Record<string, V>>;
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
  return Object.fromEntries(
    Array.from(outer.entries(), ([stream, runs]) => [
      stream,
      Object.fromEntries(
        Array.from(runs.entries(), ([runId, rounds]) => [
          runId,
          Object.fromEntries(rounds.entries()),
        ]),
      ),
    ]),
  ) as Record<string, Record<string, Record<string, V>>>;
}
