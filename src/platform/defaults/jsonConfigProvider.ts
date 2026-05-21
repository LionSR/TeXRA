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

/**
 * File-backed {@link ConfigProvider} implementation shared by non-VS-Code
 * hosts (CLI, Electron desktop).
 *
 * Keys are stored flat with the canonical `texra.*` prefix — matching the VS
 * Code extension's `texra.*` settings namespace. Bare (unprefixed) keys are
 * still accepted on read for legacy compatibility; writes always use the
 * canonical prefixed form unless a legacy unprefixed entry already exists.
 *
 * When only a workspace store is supplied (CLI), this collapses to a
 * single-tier provider. When a global store is also supplied (Electron),
 * workspace values take precedence over global values on read, and `update()`
 * routes writes by {@link ConfigTarget}.
 */
export class JsonConfigProvider implements ConfigProvider {
  private readonly watchers = createWatcherRegistry();

  constructor(
    private readonly workspaceStore: JsonStore,
    private readonly globalStore?: JsonStore,
  ) {}

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
    const store =
      target === 'global' && this.globalStore
        ? this.globalStore
        : this.workspaceStore;
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
}
