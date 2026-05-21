// Local imports - platform
import type { JsonStore } from './jsonStore';
import type { StateStore } from '../interfaces/state';

/** {@link StateStore} backed by a {@link JsonStore}. */
export class JsonStateStore implements StateStore {
  constructor(private readonly store: JsonStore) {}

  get<T>(key: string, defaultValue?: T): T {
    return this.store.get(key, defaultValue);
  }

  update(key: string, value: unknown): PromiseLike<void> {
    return this.store.set(key, value);
  }
}
