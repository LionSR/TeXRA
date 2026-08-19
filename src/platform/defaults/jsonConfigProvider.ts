import { getCoreSettingDefault } from '@shared/schemas';
import { canonicalConfigKey } from '@shared/config/configKeys';

import type {
  ConfigInspection,
  ConfigProvider,
  ConfigTarget,
} from '../interfaces';

/**
 * The store surface one config target needs. `JsonStore` satisfies it; so does
 * the in-memory twin behind `MemoryConfigProvider`, which is why the
 * layered-resolution rule below has exactly one implementation.
 */
export interface ConfigStore {
  get<T>(key: string): T | undefined;
  has(key: string): boolean;
  set(key: string, value: unknown): Promise<void>;
}

export interface JsonConfigProviderOptions {
  workspace: ConfigStore;
  global: ConfigStore;
}

/**
 * Store-backed {@link ConfigProvider}. Keys are stored flat with the canonical
 * `texra.*` prefix. Workspace values shadow global values on read and
 * `update()` routes writes by {@link ConfigTarget}.
 */
export class JsonConfigProvider implements ConfigProvider {
  private workspaceStore: ConfigStore;
  private readonly globalStore: ConfigStore;

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

  /** Switch workspace scope while retaining global values. */
  replaceWorkspaceStore(workspaceStore: ConfigStore): ConfigStore {
    const previousStore = this.workspaceStore;
    this.workspaceStore = workspaceStore;
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
  }

  inspect<T = unknown>(key: string): ConfigInspection<T> | undefined {
    const storedKey = canonicalConfigKey(key);
    return {
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
}
