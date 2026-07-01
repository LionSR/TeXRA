/**
 * A Set<string> capped at a maximum size, evicting the oldest entry (in
 * insertion order) once the cap is exceeded. Used to bound "seen id" guards
 * (out-of-order message guards, resolved-id tracking) that would otherwise
 * grow unbounded over a long-running webview session.
 */
export interface BoundedIdSet {
  has(id: string): boolean;
  add(id: string): void;
  delete(id: string): boolean;
  clear(): void;
}

export function createBoundedIdSet(cap: number): BoundedIdSet {
  const ids = new Set<string>();
  return {
    has: (id) => ids.has(id),
    delete: (id) => ids.delete(id),
    clear: () => ids.clear(),
    add(id) {
      ids.add(id);
      if (ids.size > cap) {
        // Set iteration order is insertion order — first value is oldest
        const oldest = ids.values().next().value;
        if (oldest !== undefined) ids.delete(oldest);
      }
    },
  };
}
