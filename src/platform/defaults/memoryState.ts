/**
 * In-memory state store for CLI / Electron / tests.
 */
import type { StateStore } from '../interfaces/state';

export function createMemoryStore(): StateStore {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T {
      const v = map.get(key);
      return v !== undefined ? (v as T) : (defaultValue as T);
    },
    async update(key: string, value: unknown): Promise<void> {
      map.set(key, value);
    },
  };
}
