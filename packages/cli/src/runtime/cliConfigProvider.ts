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

/**
 * File-backed {@link ConfigProvider} for the CLI host.
 *
 * Reads and writes a single JSON file (typically `.texra/config.json`) via
 * the same {@link JsonStore} used by the Electron desktop host. Keys are
 * stored flat with `texra.*` canonical prefixes — matching the VS Code
 * extension's `texra.*` settings namespace.
 */
export class CliConfigProvider implements ConfigProvider {
  private readonly watchers = createWatcherRegistry();

  constructor(private readonly store: JsonStore) {}

  get<T>(key: string, defaultValue?: T): T {
    const keys = configKeyVariants(key);
    const value = firstStoredValue<T>(this.store, keys);
    return value !== undefined ? value : (defaultValue as T);
  }

  async update<T>(
    key: string,
    value: T,
    _target?: ConfigTarget,
  ): Promise<void> {
    const keys = configKeyVariants(key);
    if (value === undefined) {
      for (const candidate of keys) {
        if (this.store.has(candidate)) {
          await this.store.set(candidate, undefined);
        }
      }
    } else {
      const storedKey =
        keys.find((candidate) => this.store.has(candidate)) ??
        canonicalConfigKey(key);
      await this.store.set(storedKey, value);
    }
    this.watchers.notify(canonicalConfigKey(key));
  }

  inspect<T = unknown>(key: string): ConfigInspection<T> | undefined {
    const keys = configKeyVariants(key);
    return {
      workspaceValue: firstStoredValue<T>(this.store, keys),
      effectiveValue: this.get<T>(key),
    };
  }

  isExplicitlySet(key: string): boolean {
    return configKeyVariants(key).some((candidate) =>
      this.store.has(candidate),
    );
  }

  watch(
    key: string | readonly string[] | RegExp,
    listener: () => void,
  ): Disposable {
    return this.watchers.add({ key, listener });
  }
}
