/** Listener fired when store state changes. */
export type StoreListener<T> = (state: T, previous: T) => void;

/** Minimal store interface shared by webview frontends. */
export interface Store<T> {
  getState(): T;
  setState(next: T): void;
  update(updater: (state: T) => T): void;
  subscribe(listener: StoreListener<T>): () => void;
}

/**
 * Create a minimal reactive store for webview state.
 */
export function createStore<T>(initialState: T): Store<T> {
  let state = initialState;
  const listeners = new Set<StoreListener<T>>();

  const notify = (next: T, previous: T) => {
    for (const listener of listeners) {
      listener(next, previous);
    }
  };

  const store: Store<T> = {
    getState: () => state,
    setState: (next) => {
      if (Object.is(next, state)) return;
      const previous = state;
      state = next;
      notify(state, previous);
    },
    update: (updater) => {
      store.setState(updater(state));
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return store;
}
