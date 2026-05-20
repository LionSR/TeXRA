import type {
  ConfigInspection,
  ConfigProvider,
  ConfigTarget,
} from '@platform/interfaces/config';
import type { Disposable } from '@platform/interfaces/disposable';
import type { JsonStore } from './jsonStore';

type ConfigWatcher = {
  key: string | readonly string[] | RegExp;
  listener: () => void;
};

/**
 * Canonical config key helpers — mirrors `ElectronConfigProvider`.
 *
 * Keys are stored flat in the JSON file. Both `texra.<key>` and bare `<key>`
 * are accepted on read (prefixed tried first). Writes always use the canonical
 * `texra.<key>` form.
 */
const TEXRA_PREFIX = 'texra.';

function stripPrefix(key: string): string {
  return key.startsWith(TEXRA_PREFIX) ? key.slice(TEXRA_PREFIX.length) : key;
}

function canonicalConfigKey(key: string): string {
  return `${TEXRA_PREFIX}${stripPrefix(key)}`;
}

function configKeyVariants(key: string): string[] {
  const unprefixed = stripPrefix(key);
  return [`${TEXRA_PREFIX}${unprefixed}`, unprefixed];
}

function matchesConfigKey(candidate: string, changedKey: string): boolean {
  return changedKey === candidate || changedKey.startsWith(`${candidate}.`);
}

function watcherMatches(
  watcherKey: ConfigWatcher['key'],
  changedKey: string,
): boolean {
  if (typeof watcherKey === 'string') {
    return configKeyVariants(watcherKey).some((candidate) =>
      matchesConfigKey(candidate, changedKey),
    );
  }
  if (watcherKey instanceof RegExp) {
    return watcherKey.test(changedKey);
  }
  if (Array.isArray(watcherKey)) {
    return watcherKey.some((item) =>
      configKeyVariants(item).some((candidate) =>
        matchesConfigKey(candidate, changedKey),
      ),
    );
  }
  return false;
}

function firstStoredValue<T>(
  store: JsonStore,
  keys: readonly string[],
): T | undefined {
  for (const candidate of keys) {
    if (store.has(candidate)) return store.get<T>(candidate);
  }
  return undefined;
}

/**
 * File-backed {@link ConfigProvider} for the CLI host.
 *
 * Reads and writes a single JSON file (typically `.texra/config.json`) via
 * the same {@link JsonStore} used by the Electron desktop host. Keys are
 * stored flat with `texra.*` canonical prefixes — matching the VS Code
 * extension's `texra.*` settings namespace.
 */
export class CliConfigProvider implements ConfigProvider {
  private readonly watchers = new Set<ConfigWatcher>();

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
    for (const watcher of this.watchers) {
      if (watcherMatches(watcher.key, canonicalConfigKey(key))) {
        watcher.listener();
      }
    }
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
    const watcher = { key, listener };
    this.watchers.add(watcher);
    return { dispose: () => this.watchers.delete(watcher) };
  }
}
