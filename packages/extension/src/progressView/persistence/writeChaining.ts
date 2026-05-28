/**
 * Per-key serialized async write queue used by the progress-view persistence
 * managers. Writes for the same key never execute concurrently, and writes
 * queued after a key is evicted (detected by absence from `pendingWrites`)
 * are silently skipped.
 */

/**
 * Enqueue a serialized async write for `key`, guarded by the `loaded`
 * flag. Writes for the same key are chained so they never execute
 * concurrently. A write queued after its key has been evicted (detected
 * by absence from `pendingWrites`) is silently skipped.
 */
export function chainStreamWrite<K>(
  key: K,
  loaded: boolean,
  pendingWrites: Map<K, Promise<void>>,
  write: () => Promise<void> | void,
): void {
  if (!loaded) return;
  const prev = pendingWrites.get(key) ?? Promise.resolve();
  const next = prev.then(() => {
    if (!pendingWrites.has(key)) return;
    return write();
  });
  pendingWrites.set(key, next.catch(() => {}));
}
