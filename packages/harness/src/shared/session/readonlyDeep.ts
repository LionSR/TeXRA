/**
 * A runtime value as a host or an embedder holds it: read-only all the
 * way down, every map, array, and record included. The value itself is not copied
 * (the fold publishes immutable levels); the type is what keeps a write
 * from reaching it. A primitive stays itself, so a branded id (a `RunId`)
 * is still that id.
 */
export type ReadonlyDeep<T> = T extends
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | ((...args: never[]) => unknown)
  ? T
  : T extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<K, ReadonlyDeep<V>>
    : T extends ReadonlySet<infer V>
      ? ReadonlySet<ReadonlyDeep<V>>
      : T extends readonly (infer E)[]
        ? readonly ReadonlyDeep<E>[]
        : T extends object
          ? { readonly [P in keyof T]: ReadonlyDeep<T[P]> }
          : T;
