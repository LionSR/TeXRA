export type StoreListener<T> = (state: T) => void;

export interface Store<T> {
  getState(): T;
  setState(next: T): void;
  update(patch: Partial<T> | ((prev: T) => T)): void;
  subscribe(listener: StoreListener<T>): () => void;
}

export const createStore = <T>(initialState: T): Store<T> => {
  let state = initialState;
  const listeners = new Set<StoreListener<T>>();

  const notify = () => {
    for (const listener of listeners) {
      listener(state);
    }
  };

  return {
    getState: () => state,
    setState: (next) => {
      state = next;
      notify();
    },
    update: (patch) => {
      if (typeof patch === 'function') {
        state = patch(state);
      } else {
        state = { ...state, ...patch };
      }
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
