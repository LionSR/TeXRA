/**
 * One resident record per key, held in a single map so dropping a key's
 * state is one `.delete()` — every field disappears with it BY
 * CONSTRUCTION. `StreamSnapshotStore` and `StreamLogStore` independently
 * arrived at this same "one record per stream" shape for their own
 * per-stream lifecycle bookkeeping (each had previously needed a
 * hand-maintained list of parallel maps/sets that had already drifted once
 * before being unified — see each store's own record-type doc comment for
 * the specifics). This factors out the shared container so a future
 * accumulator or lifecycle flag doesn't need its own bespoke
 * get-or-create/prune/evict wiring.
 *
 * The one capability that is opt-in per consumer is {@link pruneIfEmpty}:
 * `StreamSnapshotStore`, whose records persist until an explicit delete,
 * never calls it. Anything a store guards per stream beyond presence — a
 * generation token, a seed chain — is a field on its own record, so the
 * container never carries a second map that `delete()` could miss. The two
 * stores' own persistence-strategy code (per-(key,category) write mutexes vs
 * debounce) is NOT part of this container and stays on each store.
 */
export class ResidentStreamRegistry<TId, TState> {
  private readonly records = new Map<TId, TState>();

  constructor(private readonly createDefault: () => TState) {}

  getOrCreate(id: TId): TState {
    let record = this.records.get(id);
    if (!record) {
      record = this.createDefault();
      this.records.set(id, record);
    }
    return record;
  }

  get(id: TId): TState | undefined {
    return this.records.get(id);
  }

  delete(id: TId): boolean {
    return this.records.delete(id);
  }

  clear(): void {
    this.records.clear();
  }

  keys(): IterableIterator<TId> {
    return this.records.keys();
  }

  values(): IterableIterator<TState> {
    return this.records.values();
  }

  [Symbol.iterator](): IterableIterator<[TId, TState]> {
    return this.records.entries();
  }

  /** Drop a record once `isEmpty` reports no field on it still holds state. */
  pruneIfEmpty(id: TId, isEmpty: (state: TState) => boolean): void {
    const record = this.records.get(id);
    if (record && isEmpty(record)) this.records.delete(id);
  }
}
