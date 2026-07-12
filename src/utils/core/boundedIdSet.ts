import { LRUCache } from 'lru-cache';

/**
 * A Set<Id> capped at a maximum size, evicting the least-recently-used
 * entry once the cap is exceeded. Used to bound "seen id" guards
 * (out-of-order message guards, resolved-id tracking, poll dedup) that
 * would otherwise grow unbounded over a long-running session.
 */
export interface BoundedIdSet<Id> {
  readonly size: number;
  has(id: Id): boolean;
  add(id: Id): void;
  delete(id: Id): boolean;
  clear(): void;
  [Symbol.iterator](): IterableIterator<Id>;
}

export function createBoundedIdSet<Id extends NonNullable<unknown> = string>(
  cap: number,
): BoundedIdSet<Id> {
  const ids = new LRUCache<Id, true>({ max: cap });
  return {
    get size() {
      return ids.size;
    },
    has: (id) => ids.has(id),
    delete: (id) => ids.delete(id),
    clear: () => ids.clear(),
    add: (id) => void ids.set(id, true),
    [Symbol.iterator]: () => ids.keys(),
  };
}
