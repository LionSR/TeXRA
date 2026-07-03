import { LRUCache } from 'lru-cache';

/**
 * A Set<string> capped at a maximum size, evicting the oldest entry once the
 * cap is exceeded. Used to bound "seen id" guards (out-of-order message
 * guards, resolved-id tracking) that would otherwise grow unbounded over a
 * long-running webview session.
 */
export interface BoundedIdSet {
  has(id: string): boolean;
  add(id: string): void;
  delete(id: string): boolean;
  clear(): void;
}

export function createBoundedIdSet(cap: number): BoundedIdSet {
  const ids = new LRUCache<string, true>({ max: cap });
  return {
    has: (id) => ids.has(id),
    delete: (id) => ids.delete(id),
    clear: () => ids.clear(),
    add: (id) => {
      if (ids.has(id)) return;
      ids.set(id, true);
    },
  };
}
