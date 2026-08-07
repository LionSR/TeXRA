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
 * Every capability here is opt-in per consumer: a store with no "prune once
 * every field is empty" concept (`StreamSnapshotStore`, whose records
 * persist until an explicit `evict`) simply never calls {@link pruneIfEmpty},
 * and a store with no per-key version counter (`StreamLogStore`, which
 * tracks a single store-wide revision instead) never calls
 * {@link version}/{@link bumpVersion}/{@link evict}/{@link evictAll}. The
 * two stores' own persistence-strategy code (per-(key,category) write
 * mutexes vs debounce+generation) is NOT part of this container and stays
 * on each store.
 */
export class ResidentStreamRegistry<TId, TState> {
  private readonly records = new Map<TId, TState>();
  /**
   * Per-key version counters. Deliberately never deleted — not even by
   * {@link evict}/{@link evictAll} — so a version captured before a key's
   * record is dropped still lets an in-flight async operation detect that it
   * raced against a later change for the same key.
   */
  private readonly versions = new Map<TId, number>();

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

  version(id: TId): number {
    return this.versions.get(id) ?? 0;
  }

  bumpVersion(id: TId): void {
    this.versions.set(id, this.version(id) + 1);
  }

  /** Bump a key's version, then drop its record — the two always happen together. */
  evict(id: TId): void {
    this.bumpVersion(id);
    this.records.delete(id);
  }

  evictAll(): void {
    for (const id of this.records.keys()) this.bumpVersion(id);
    this.records.clear();
  }
}
