import { getCoreSettingDefault } from '@shared/schemas';
import {
  canonicalConfigKey,
  createWatcherRegistry,
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
 * `texra.*` prefix. Workspace values shadow global values on read and
 * `update()` routes writes by {@link ConfigTarget}.
 */
export class JsonConfigProvider implements ConfigProvider {
  private readonly watchers = createWatcherRegistry();
  private workspaceStore: JsonStore;
  private readonly globalStore: JsonStore;

  constructor({ workspace, global }: JsonConfigProviderOptions) {
    this.workspaceStore = workspace;
    this.globalStore = global;
  }

  get<T>(key: string, defaultValue?: T): T {
    const storedKey = canonicalConfigKey(key);
    const workspaceValue = this.workspaceStore.get<T>(storedKey);
    if (workspaceValue !== undefined) return workspaceValue;
    const globalValue = this.globalStore.get<T>(storedKey);
    if (globalValue !== undefined) return globalValue;
    const schemaDefault = getCoreSettingDefault(storedKey) as T | undefined;
    return schemaDefault === undefined ? (defaultValue as T) : schemaDefault;
  }

  /** Switch workspace scope while retaining global values and subscriptions. */
  replaceWorkspaceStore(workspaceStore: JsonStore): JsonStore {
    const previousStore = this.workspaceStore;
    const affectedKeys = new Set([
      ...Object.keys(previousStore.snapshot()),
      ...Object.keys(workspaceStore.snapshot()),
    ]);
    this.workspaceStore = workspaceStore;
    for (const key of affectedKeys) this.watchers.notify(key);
    return previousStore;
  }

  async update<T>(
    key: string,
    value: T,
    target: ConfigTarget = 'workspace',
  ): Promise<void> {
    const store = target === 'global' ? this.globalStore : this.workspaceStore;
    const storedKey = canonicalConfigKey(key);
    // JsonStore.set treats `undefined` as a delete.
    await store.set(storedKey, value);
    this.watchers.notify(storedKey);
  }

  inspect<T = unknown>(key: string): ConfigInspection<T> | undefined {
    const storedKey = canonicalConfigKey(key);
    const defaultValue = getCoreSettingDefault(storedKey) as T | undefined;
    return {
      ...(defaultValue !== undefined && { defaultValue }),
      globalValue: this.globalStore.get<T>(storedKey),
      workspaceValue: this.workspaceStore.get<T>(storedKey),
    };
  }

  isExplicitlySet(key: string): boolean {
    const storedKey = canonicalConfigKey(key);
    return (
      this.workspaceStore.has(storedKey) || this.globalStore.has(storedKey)
    );
  }

  watch(
    key: string | readonly string[] | RegExp,
    listener: () => void,
  ): Disposable {
    return this.watchers.add({ key, listener });
  }
}
