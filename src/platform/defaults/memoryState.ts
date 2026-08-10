// Local imports - platform
import type { StateStore } from '../interfaces';

/** In-memory platform state store for CLI, tests, and lightweight hosts. */
export class MemoryStateStore implements StateStore {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T {
    return this.values.has(key)
      ? (this.values.get(key) as T)
      : (defaultValue as T);
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.values.delete(key);
      return;
    }
    this.values.set(key, value);
  }
}
