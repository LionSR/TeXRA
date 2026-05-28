/**
 * Enqueue a serialized async write for `key`, guarded by `loaded`. Writes
 * for the same key never execute concurrently — each new write chains
 * after the previous pending one. A write queued after its key has been
 * evicted is silently skipped: eviction is signalled by removing the key
 * from `pendingWrites`, so absence inside the `.then()` callback means
 * "skip this write."
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
  pendingWrites.set(
    key,
    next.catch(() => {}),
  );
}
