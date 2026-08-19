import { JsonConfigProvider, type ConfigStore } from './jsonConfigProvider';

/** Process-local {@link ConfigStore}, the in-memory twin of a `JsonStore`. */
class MemoryConfigStore implements ConfigStore {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    // `JsonStore.set` treats `undefined` as a delete; match it so
    // `isExplicitlySet` agrees across backings.
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
  }
}

/**
 * In-memory {@link ConfigProvider} for process-local hosts (the default Node
 * platform, tests). Settings resolve exactly as they do for a file-backed
 * host — workspace shadows global, then the core-schema default, then the
 * caller's fallback — because it is the same provider over in-memory stores,
 * not a second implementation of the same rule.
 */
export class MemoryConfigProvider extends JsonConfigProvider {
  constructor() {
    super({
      workspace: new MemoryConfigStore(),
      global: new MemoryConfigStore(),
    });
  }
}
