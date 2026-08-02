/**
 * A minimal listener registry: `add()` subscribes and returns a disposer,
 * `clear()` drops everyone, and iteration (`for...of`, `[...set]`) reaches the
 * underlying listeners directly so each call site keeps choosing live vs.
 * snapshot iteration exactly as a hand-rolled `Set` would. Collapses the
 * "Set + add-returns-a-disposer-that-deletes" shape repeated across the
 * runtime and host-interaction layers.
 */
export interface ListenerSet<T extends (...args: never[]) => void> {
  add(listener: T): () => void;
  clear(): void;
  [Symbol.iterator](): IterableIterator<T>;
}

export function createListenerSet<
  T extends (...args: never[]) => void,
>(): ListenerSet<T> {
  const listeners = new Set<T>();
  return {
    add: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear: () => listeners.clear(),
    [Symbol.iterator]: () => listeners.values(),
  };
}
