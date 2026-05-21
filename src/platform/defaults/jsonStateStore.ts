// Local imports - platform
import type { JsonStore } from './jsonStore';
import type { StateStore } from '../interfaces/state';

/**
 * {@link StateStore} backed by a {@link JsonStore}.
 *
 * Shared by the CLI and Electron desktop hosts — both persist key-value state
 * to a single flat JSON file on disk. The VS Code host uses
 * `vscode.Memento` directly and does not go through this adapter.
 */
export class JsonStateStore implements StateStore {
  constructor(private readonly store: JsonStore) {}

  get<T>(key: string, defaultValue?: T): T {
    return this.store.get(key, defaultValue);
  }

  update(key: string, value: unknown): PromiseLike<void> {
    return this.store.set(key, value);
  }
}
