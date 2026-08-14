/**
 * Keyed cache of lazily-created {@link KVStore} handles.
 *
 * Per-stream and per-execution stores all hand-rolled the same thin
 * lifecycle over KVStore: resolve the key's backing directory, create the
 * handle on first access, and drop the cached handle when the directory it
 * resolved may have moved (staged-deletion rollback, storage-root
 * replacement) so the next access re-resolves. This cache owns that
 * lifecycle so each store routes through one implementation instead of
 * re-deriving get-or-create plus invalidation per site.
 *
 * Handles are stateless wrappers over a directory path, so dropping one is
 * lossless: an invalidated or LRU-evicted handle is recreated identically on
 * the next {@link get}. `max` exists only to bound the cache over an
 * unbounded key space (e.g. execution ids); key spaces already bounded by
 * their owners leave it unset.
 */

import { LRUCache } from 'lru-cache';

import { KVStore } from '@common/storage/KVStore';

export class KVStoreCache<
  TId extends NonNullable<unknown>,
  TStore extends KVStore = KVStore,
> {
  private readonly handles: Map<TId, TStore> | LRUCache<TId, TStore>;

  /**
   * @param create Resolve `id`'s directory and construct its store.
   * @param max Cap on cached handles; the least-recently-used handle is
   *   evicted (losslessly) once exceeded. Unset means unbounded — LRUCache
   *   preallocates per-cap index structures, so an unbounded cache is a
   *   plain Map rather than an LRUCache with a fake-infinite cap.
   */
  constructor(
    private readonly create: (id: TId) => TStore,
    { max }: { max?: number } = {},
  ) {
    this.handles = max === undefined ? new Map() : new LRUCache({ max });
  }

  /** The id's handle, created and cached on first access. */
  get(id: TId): TStore {
    let handle = this.handles.get(id);
    if (!handle) {
      handle = this.create(id);
      this.handles.set(id, handle);
    }
    return handle;
  }

  /** Drop the id's cached handle so the next {@link get} re-resolves it. */
  invalidate(id: TId): void {
    this.handles.delete(id);
  }

  /** Drop every cached handle, e.g. after a storage-root replacement. */
  invalidateAll(): void {
    this.handles.clear();
  }
}
