import type { JsonStore } from '@platform/defaults/jsonStore';
import type { StateStore } from '@platform/interfaces/state';

export class ElectronStateStore implements StateStore {
  constructor(private readonly store: JsonStore) {}

  get<T>(key: string, defaultValue?: T): T {
    return this.store.get(key, defaultValue);
  }

  update(key: string, value: unknown): PromiseLike<void> {
    return this.store.set(key, value);
  }
}
