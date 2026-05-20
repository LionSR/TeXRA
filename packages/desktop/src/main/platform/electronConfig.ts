import {
  canonicalConfigKey,
  configKeyVariants,
  createWatcherRegistry,
  firstStoredValue,
} from '@platform/defaults/configKeyHelpers';
import type { JsonStore } from '@platform/defaults/jsonStore';
import type {
  ConfigInspection,
  ConfigProvider,
  ConfigTarget,
} from '@platform/interfaces/config';
import type { Disposable } from '@platform/interfaces/disposable';

export class ElectronConfigProvider implements ConfigProvider {
  private readonly watchers = createWatcherRegistry();

  constructor(
    private readonly globalStore: JsonStore,
    private readonly workspaceStore: JsonStore,
  ) {}

  get<T>(key: string, defaultValue?: T): T {
    const keys = configKeyVariants(key);
    const workspaceValue = firstStoredValue<T>(this.workspaceStore, keys);
    if (workspaceValue !== undefined) return workspaceValue;
    const globalValue = firstStoredValue<T>(this.globalStore, keys);
    if (globalValue !== undefined) return globalValue;
    return defaultValue as T;
  }

  async update<T>(
    key: string,
    value: T,
    target: ConfigTarget = 'workspace',
  ): Promise<void> {
    const store = target === 'global' ? this.globalStore : this.workspaceStore;
    const keys = configKeyVariants(key);
    if (value === undefined) {
      await Promise.all(
        keys
          .filter((candidate) => store.has(candidate))
          .map((candidate) => store.set(candidate, undefined)),
      );
    } else {
      const storedKey =
        keys.find((candidate) => store.has(candidate)) ??
        canonicalConfigKey(key);
      await store.set(storedKey, value);
    }
    this.watchers.notify(canonicalConfigKey(key));
  }

  inspect<T = unknown>(key: string): ConfigInspection<T> | undefined {
    const keys = configKeyVariants(key);
    return {
      globalValue: firstStoredValue<T>(this.globalStore, keys),
      workspaceValue: firstStoredValue<T>(this.workspaceStore, keys),
      effectiveValue: this.get<T>(key),
    };
  }

  isExplicitlySet(key: string): boolean {
    return configKeyVariants(key).some(
      (candidate) =>
        this.globalStore.has(candidate) || this.workspaceStore.has(candidate),
    );
  }

  watch(
    key: string | readonly string[] | RegExp,
    listener: () => void,
  ): Disposable {
    return this.watchers.add({ key, listener });
  }
}
