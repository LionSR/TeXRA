import { Effect } from 'effect';

import { getCoreSettingDefault } from '@shared/schemas';
import { canonicalConfigKey } from '@shared/config/configKeys';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  ConfigWriteFailed,
  type ConfigInspection,
  type ConfigProvider,
  type ConfigTarget,
} from '../interfaces';

/**
 * The store surface one config target needs. `JsonStore` satisfies it; so does
 * the in-memory twin behind `MemoryConfigProvider`, which is why the
 * layered-resolution rule below has exactly one implementation.
 *
 * `set` is the store's own Effect write, named as the secret and state stores
 * name theirs. It carries no requirements and no injected runner: a store that
 * needs host services (the JSON one wants the filesystem) provides them for
 * the effect itself, so this port's members compose into any caller's program.
 */
export interface ConfigStore {
  get<T>(key: string): T | undefined;
  has(key: string): boolean;
  set(key: string, value: unknown): Effect.Effect<void, Error>;
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
  private readonly workspaceStore: ConfigStore;
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

  update<T>(
    key: string,
    value: T,
    target: ConfigTarget = 'workspace',
  ): Effect.Effect<void, ConfigWriteFailed> {
    const store = target === 'global' ? this.globalStore : this.workspaceStore;
    const storedKey = canonicalConfigKey(key);
    // A store treats `undefined` as a delete.
    return store.set(storedKey, value).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigWriteFailed({
            key: storedKey,
            target,
            message: `The ${target} configuration store refused the write of "${storedKey}": ${toErrorMessage(cause)}`,
            cause,
          }),
      ),
    );
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
