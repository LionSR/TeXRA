/**
 * VS Code implementation of the platform-agnostic {@link StateStore}.
 *
 * `vscode.Memento` is the shape the port mirrors, but its `update` is a
 * `Thenable`: this turns that write into the port's `Effect` so the caller's
 * fiber owns it and a rejection is a typed {@link StoreWriteFailed} rather
 * than an unhandled promise.
 *
 * One instance per `Memento`: the roster's per-store write lane keys on store
 * identity, so two wrappers over the same memento would not serialize against
 * each other.
 */
import { Effect } from 'effect';
import type * as vscode from 'vscode';

import { StoreWriteFailed, type StateStore } from '@platform/interfaces';
import { toErrorMessage } from '@utils/errors/errorMessage';

class VscodeStateStore implements StateStore {
  constructor(private readonly memento: vscode.Memento) {}

  get<T>(key: string, defaultValue?: T): T {
    return this.memento.get<T>(key, defaultValue as T);
  }

  update(key: string, value: unknown): Effect.Effect<void, StoreWriteFailed> {
    return Effect.tryPromise({
      try: async () => this.memento.update(key, value),
      catch: (cause) =>
        new StoreWriteFailed({
          reason: 'io',
          key,
          message: `VS Code rejected the state write for "${key}": ${toErrorMessage(cause)}`,
          cause,
        }),
    });
  }
}

const stores = new WeakMap<vscode.Memento, StateStore>();

/** The one {@link StateStore} over this memento. */
export function vscodeStateStore(memento: vscode.Memento): StateStore {
  let store = stores.get(memento);
  if (!store) {
    store = new VscodeStateStore(memento);
    stores.set(memento, store);
  }
  return store;
}
