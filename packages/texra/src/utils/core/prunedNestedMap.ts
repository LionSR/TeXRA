/**
 * A two-level map whose inner maps leave it when they empty, so the outer
 * level is bounded by groups that hold something. The one home of the
 * "get-or-create the inner map, delete it once empty" dance that per-run and
 * per-project registries otherwise spell out at every write.
 */
export class PrunedNestedMap<A, B, V> {
  private readonly outer = new Map<A, Map<B, V>>();

  get(a: A, b: B): V | undefined {
    return this.outer.get(a)?.get(b);
  }

  set(a: A, b: B, value: V): void {
    const inner = this.outer.get(a);
    if (inner) inner.set(b, value);
    else this.outer.set(a, new Map([[b, value]]));
  }

  /** Remove one entry; returns it, or `undefined` when there was none. */
  delete(a: A, b: B): V | undefined {
    const inner = this.outer.get(a);
    const value = inner?.get(b);
    if (inner === undefined || value === undefined) return undefined;
    inner.delete(b);
    if (inner.size === 0) this.outer.delete(a);
    return value;
  }

  deleteGroup(a: A): void {
    this.outer.delete(a);
  }

  /** The live entries of one group; empty when it has none. */
  group(a: A): ReadonlyMap<B, V> {
    return this.outer.get(a) ?? new Map();
  }

  groups(): IterableIterator<[A, ReadonlyMap<B, V>]> {
    return this.outer.entries();
  }

  clear(): void {
    this.outer.clear();
  }
}
