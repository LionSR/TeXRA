import {
  canonicalConfigKey,
  configKeyVariants,
  createWatcherRegistry,
  firstStoredValue,
} from './configKeyHelpers';

import type { JsonStore } from './jsonStore';
import type {
  ConfigInspection,
  ConfigProvider,
  ConfigTarget,
} from '../interfaces/config';
import type { Disposable } from '../interfaces/disposable';

export interface JsonConfigProviderOptions {
  workspace: JsonStore;
  global?: JsonStore;
}

/**
 * File-backed {@link ConfigProvider}. Keys are stored flat with the canonical
 * `texra.*` prefix; bare keys are accepted on read for legacy compatibility.
 * Writes use the canonical prefixed form unless a legacy unprefixed entry
 * already exists. When a `global` store is supplied, workspace values shadow
 * global values on read and `update()` routes writes by {@link ConfigTarget}.
 * Writing to `'global'` without a `global` store throws.
 */
export class JsonConfigProvider implements ConfigProvider {
  private readonly watchers = createWatcherRegistry();
  private readonly workspaceStore: JsonStore;
  private readonly globalStore: JsonStore | undefined;

  constructor({ workspace, global }: JsonConfigProviderOptions) {
    this.workspaceStore = workspace;
    this.globalStore = global;
  }

  get<T>(key: string, defaultValue?: T): T {
    const keys = configKeyVariants(key);
    const workspaceValue = firstStoredValue<T>(this.workspaceStore, keys);
    if (workspaceValue !== undefined) return workspaceValue;
    if (this.globalStore) {
      const globalValue = firstStoredValue<T>(this.globalStore, keys);
      if (globalValue !== undefined) return globalValue;
    }
    return defaultValue as T;
  }

  async update<T>(
    key: string,
    value: T,
    target: ConfigTarget = 'workspace',
  ): Promise<void> {
    const store = this.storeForWrite(target);
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
      globalValue: this.globalStore
        ? firstStoredValue<T>(this.globalStore, keys)
        : undefined,
      workspaceValue: firstStoredValue<T>(this.workspaceStore, keys),
      effectiveValue: this.get<T>(key),
    };
  }

  isExplicitlySet(key: string): boolean {
    return configKeyVariants(key).some(
      (candidate) =>
        this.workspaceStore.has(candidate) ||
        (this.globalStore?.has(candidate) ?? false),
    );
  }

  watch(
    key: string | readonly string[] | RegExp,
    listener: () => void,
  ): Disposable {
    return this.watchers.add({ key, listener });
  }

  private storeForWrite(target: ConfigTarget): JsonStore {
    if (target === 'global') {
      if (!this.globalStore) {
        throw new Error(
          "JsonConfigProvider was constructed without a global store; cannot update with target='global'.",
        );
      }
      return this.globalStore;
    }
    return this.workspaceStore;
  }
}
