import type { Disposable } from '@platform/interfaces/disposable';
import type { JsonStore } from './jsonStore';

/**
 * Helpers shared by file-backed `ConfigProvider` implementations (Electron,
 * CLI). Keys are stored flat in a JSON file. Both `texra.<key>` and bare
 * `<key>` are accepted on read (canonical prefixed form tried first). Writes
 * always use the canonical `texra.<key>` form unless an unprefixed legacy
 * entry already exists for that key.
 */
const TEXRA_PREFIX = 'texra.';

export function stripPrefix(key: string): string {
  return key.startsWith(TEXRA_PREFIX) ? key.slice(TEXRA_PREFIX.length) : key;
}

export function canonicalConfigKey(key: string): string {
  return `${TEXRA_PREFIX}${stripPrefix(key)}`;
}

export function configKeyVariants(key: string): string[] {
  const unprefixed = stripPrefix(key);
  return [`${TEXRA_PREFIX}${unprefixed}`, unprefixed];
}

function matchesConfigKey(candidate: string, changedKey: string): boolean {
  return changedKey === candidate || changedKey.startsWith(`${candidate}.`);
}

export interface ConfigWatcher {
  key: string | readonly string[] | RegExp;
  listener: () => void;
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

export function firstStoredValue<T>(
  store: JsonStore,
  keys: readonly string[],
): T | undefined {
  for (const candidate of keys) {
    if (store.has(candidate)) return store.get<T>(candidate);
  }
  return undefined;
}

export function createWatcherRegistry(): {
  add(watcher: ConfigWatcher): Disposable;
  notify(changedKey: string): void;
} {
  const watchers = new Set<ConfigWatcher>();
  return {
    add(watcher) {
      watchers.add(watcher);
      return { dispose: () => watchers.delete(watcher) };
    },
    notify(changedKey) {
      for (const watcher of watchers) {
        if (watcherMatches(watcher.key, changedKey)) {
          watcher.listener();
        }
      }
    },
  };
}
