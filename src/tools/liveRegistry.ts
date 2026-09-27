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
 *   builds for it, for the caller's scope. Generations are reference counted
 *   by digest, so readers of equal generations share one acquisition, and a
 *   generation nothing pins any more is released (it drains) even when
 *   `current` has moved on.
 */
import {
  Data,
  Effect,
  Equal,
  Hash,
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
  /** A digest of `entries`: equal digests mean equal entries. */
  readonly digest: string;
  readonly entries: ReadonlyMap<K, V>;
  /** The owner of each entry. */
  readonly owners: ReadonlyMap<K, string>;
}

/** A pinned generation and the resources acquired for it. */
interface Pinned<K, V, A> {
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

/** The generation key the pin map counts by: its digest alone. */
class GenerationKey<K, V> implements Equal.Equal {
  constructor(readonly generation: Generation<K, V>) {}
  [Equal.symbol](that: Equal.Equal): boolean {
    return (
      that instanceof GenerationKey &&
      that.generation.digest === this.generation.digest
    );
  }
  [Hash.symbol](): number {
    return Hash.string(this.generation.digest);
  }
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
 * A registry in the caller's scope. `digest` names a set of entries;
 * `acquire` builds a generation's resources when it is first pinned, released
 * when the last pin of that digest closes.
 */
export const makeRegistry = Effect.fnUntraced(function* <K, V, A>(options: {
  readonly digest: (entries: ReadonlyMap<K, V>) => string;
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
    return { id: nextId, digest: options.digest(entries), entries, owners };
  };
  const contributions = yield* SynchronizedRef.make<
    readonly Contribution<K, V>[]
  >([]);
  const current = yield* SubscriptionRef.make(build([]));
  const pins = yield* RcMap.make({
    lookup: (key: GenerationKey<K, V>) =>
      Effect.map(options.acquire(key.generation), (resources) => ({
        generation: key.generation,
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
      RcMap.get(pins, new GenerationKey(generation)),
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
