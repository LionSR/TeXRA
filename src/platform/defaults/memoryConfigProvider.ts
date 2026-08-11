import { getCoreSettingDefault } from '@shared/schemas';
import {
  canonicalConfigKey,
  createWatcherRegistry,
} from '@shared/config/configKeys';

import type {
  ConfigInspection,
  ConfigProvider,
  ConfigTarget,
  Disposable,
} from '../interfaces';

/**
 * In-memory {@link ConfigProvider} for process-local hosts (the default Node
 * platform, tests). Resolves settings exactly like the file-backed
 * {@link JsonConfigProvider}: workspace values shadow global values, then the
 * core-schema default, then the caller's fallback — so embedders observe the
 * same effective settings as every host.
 */
export class MemoryConfigProvider implements ConfigProvider {
  private readonly global = new Map<string, unknown>();
  private readonly workspace = new Map<string, unknown>();
  private readonly watchers = createWatcherRegistry();

  get<T>(key: string, defaultValue?: T): T {
    const storedKey = canonicalConfigKey(key);
    const workspaceValue = this.workspace.get(storedKey) as T | undefined;
    if (workspaceValue !== undefined) return workspaceValue;
    const globalValue = this.global.get(storedKey) as T | undefined;
    if (globalValue !== undefined) return globalValue;
    const schemaDefault = getCoreSettingDefault(storedKey) as T | undefined;
    return schemaDefault === undefined ? (defaultValue as T) : schemaDefault;
  }

  async update<T>(
    key: string,
    value: T,
    target: ConfigTarget = 'workspace',
  ): Promise<void> {
    const values = target === 'global' ? this.global : this.workspace;
    const storedKey = canonicalConfigKey(key);
    if (value === undefined) {
      values.delete(storedKey);
    } else {
      values.set(storedKey, value);
    }
    this.watchers.notify(storedKey);
  }

  inspect<T = unknown>(key: string): ConfigInspection<T> {
    const storedKey = canonicalConfigKey(key);
    const defaultValue = getCoreSettingDefault(storedKey) as T | undefined;
    return {
      ...(defaultValue !== undefined && { defaultValue }),
      globalValue: this.global.get(storedKey) as T | undefined,
      workspaceValue: this.workspace.get(storedKey) as T | undefined,
    };
  }

  isExplicitlySet(key: string): boolean {
    const storedKey = canonicalConfigKey(key);
    return this.workspace.has(storedKey) || this.global.has(storedKey);
  }

  watch(
    key: string | readonly string[] | RegExp,
    listener: () => void,
  ): Disposable {
    return this.watchers.add({ key, listener });
  }
}
