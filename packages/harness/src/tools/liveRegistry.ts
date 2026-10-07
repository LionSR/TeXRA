/**
 * A generational catalog: plugins contribute entries from their own scope,
 * every change rebuilds one immutable generation from the active
 * contributions, and a reader pins a generation for as long as its scope
 * lives (`2026-09-26-core-concepts.md`, "Central primitives", Registry).
 *
 * - **Contribute.** `contribute(owner, entries)` adds a contribution until
 *   the caller's scope closes, when it is withdrawn and the catalog rebuilds.
 *   A name another owner holds is refused with `RegistryConflict`, loudly,
 *   never overwritten. A later contribution from the same owner supersedes
 *   its earlier one while both are open (a reloaded server's new revision),
 *   and the earlier one is current again if the later closes first.
 * - **Rebuild.** A change never patches a generation: it builds the next one
 *   from every active contribution and publishes it on `current`.
 * - **Pin.** `pin` holds the current generation, and the resources `acquire`
 *   builds for it, for the caller's scope. Each published generation is
 *   reference counted as itself, never by its contents, so readers of the
 *   same generation share one acquisition, a rebuild whose entries are equal
 *   still acquires its own, and a generation nothing pins any more is
 *   released (it drains) even when `current` has moved on.
 */
import {
  Data,
  Effect,
  Equal,
  RcMap,
  type Scope,
  SubscriptionRef,
  SynchronizedRef,
} from 'effect';

/** A name one owner contributes that another owner already holds. */
class RegistryConflict extends Data.TaggedError('RegistryConflict')<{
  readonly owner: string;
  readonly name: string;
  readonly heldBy: string;
}> {
  override get message(): string {
    return `${this.owner} contributes "${this.name}", which ${this.heldBy} already contributes.`;
  }
}

/** One immutable build of the catalog. */
export interface Generation<K, V> {
  /** Increases with every rebuild in this process. */
  readonly id: number;
  readonly entries: ReadonlyMap<K, V>;
  /** The owner of each entry. */
  readonly owners: ReadonlyMap<K, string>;
}

/** A pinned generation and the resources acquired for it. */
export interface Pinned<K, V, A> {
  readonly generation: Generation<K, V>;
  readonly resources: A;
}

export interface Registry<K, V, A> {
  readonly current: SubscriptionRef.SubscriptionRef<Generation<K, V>>;
  readonly pin: Effect.Effect<Pinned<K, V, A>, never, Scope.Scope>;
  readonly contribute: (
    owner: string,
    entries: ReadonlyMap<K, V>,
  ) => Effect.Effect<void, RegistryConflict, Scope.Scope>;
}

interface Contribution<K, V> {
  readonly token: symbol;
  readonly owner: string;
  readonly entries: ReadonlyMap<K, V>;
}

/** Each owner's latest open contribution, in first-contribution order. */
const effective = <K, V>(
  contributions: readonly Contribution<K, V>[],
): Map<string, Contribution<K, V>> => {
  const byOwner = new Map<string, Contribution<K, V>>();
  for (const contribution of contributions)
    byOwner.set(contribution.owner, contribution);
  return byOwner;
};

/**
 * A registry in the caller's scope. `acquire` builds a generation's resources
 * when it is first pinned, released when its last pin closes.
 */
export const makeRegistry = Effect.fnUntraced(function* <K, V, A>(options: {
  readonly acquire: (
    generation: Generation<K, V>,
  ) => Effect.Effect<A, never, Scope.Scope>;
}) {
  let nextId = 0;
  const build = (
    contributions: readonly Contribution<K, V>[],
  ): Generation<K, V> => {
    const entries = new Map<K, V>();
    const owners = new Map<K, string>();
    for (const { owner, entries: own } of effective(contributions).values()) {
      for (const [key, value] of own) {
        entries.set(key, value);
        owners.set(key, owner);
      }
    }
    nextId += 1;
    // Its identity as a pin key: two builds are never the same generation,
    // since each may carry resources the other does not.
    return Equal.byReference({ id: nextId, entries, owners });
  };
  const contributions = yield* SynchronizedRef.make<
    readonly Contribution<K, V>[]
  >([]);
  const current = yield* SubscriptionRef.make(build([]));
  const pins = yield* RcMap.make({
    lookup: (generation: Generation<K, V>) =>
      Effect.map(options.acquire(generation), (resources) => ({
        generation,
        resources,
      })),
  });
  /** Replace the contributions and publish the generation they build, in
   *  one step, so `current` changes in the order the contributions did. */
  const publish = (next: readonly Contribution<K, V>[]) =>
    SubscriptionRef.set(current, build(next)).pipe(Effect.as(next));

  const registry: Registry<K, V, A> = {
    current,
    pin: Effect.flatMap(SubscriptionRef.get(current), (generation) =>
      RcMap.get(pins, generation),
    ),
    contribute: (owner, entries) =>
      Effect.acquireRelease(
        SynchronizedRef.modifyEffect(contributions, (list) => {
          // Every open contribution counts, not only each owner's latest:
          // a superseded one takes effect again when the newer one closes.
          for (const other of list) {
            if (other.owner === owner) continue;
            for (const name of entries.keys()) {
              if (other.entries.has(name))
                return Effect.fail(
                  new RegistryConflict({
                    owner,
                    name: String(name),
                    heldBy: other.owner,
                  }),
                );
            }
          }
          const token = Symbol(owner);
          return publish([...list, { token, owner, entries }]).pipe(
            Effect.map((next) => [token, next] as const),
          );
        }),
        (token) =>
          SynchronizedRef.updateEffect(contributions, (list) =>
            publish(list.filter((entry) => entry.token !== token)),
          ),
      ).pipe(Effect.asVoid),
  };
  return registry;
});
