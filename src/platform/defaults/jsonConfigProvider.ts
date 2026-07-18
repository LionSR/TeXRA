import {
  canonicalConfigKey,
  configKeyVariants,
  createWatcherRegistry,
  firstStoredValue,
} from '@shared/config/configKeys';

import type { JsonStore } from './jsonStore';
import type {
  ConfigInspection,
  ConfigProvider,
  ConfigTarget,
  Disposable,
} from '../interfaces';

export interface JsonConfigProviderOptions {
  workspace: JsonStore;
  global: JsonStore;
}

/**
 * File-backed {@link ConfigProvider}. Keys are stored flat with the canonical
 * `texra.*` prefix; bare keys are accepted on read for legacy compatibility.
 * Writes use the canonical prefixed form unless a legacy unprefixed entry
 * already exists. Workspace values shadow global values on read and
 * `update()` routes writes by {@link ConfigTarget}.
 */
export class JsonConfigProvider implements ConfigProvider {
  private readonly watchers = createWatcherRegistry();
  private readonly workspaceStore: JsonStore;
  private readonly globalStore: JsonStore;

  constructor({ workspace, global }: JsonConfigProviderOptions) {
    this.workspaceStore = workspace;
    this.globalStore = global;
  }

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
        this.workspaceStore.has(candidate) || this.globalStore.has(candidate),
    );
  }

  watch(
    key: string | readonly string[] | RegExp,
    listener: () => void,
  ): Disposable {
    return this.watchers.add({ key, listener });
  }
}
