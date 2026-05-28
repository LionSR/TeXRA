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

/**
 * Enqueue a serialized async write for `stream`, guarded by the `loaded`
 * flag. Writes for the same stream are chained so they never execute
 * concurrently. A write queued after its stream has been evicted (detected
 * by absence from `pendingWrites`) is silently skipped.
 */
export function chainStreamWrite<K>(
  stream: K,
  loaded: boolean,
  pendingWrites: Map<K, Promise<void>>,
  write: () => Promise<void> | void,
): void {
  if (!loaded) return;
  const prev = pendingWrites.get(stream) ?? Promise.resolve();
  const next = prev.then(() => {
    if (!pendingWrites.has(stream)) return;
    return write();
  });
  pendingWrites.set(stream, next.catch(() => {}));
}
