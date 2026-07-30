/**
 * Shared TeXRA configuration key helpers.
 *
 * Hosts store settings as flat keys. Both `texra.<key>` and bare `<key>` are
 * accepted on read for legacy compatibility; writes use the canonical prefixed
 * form unless a legacy bare key already exists.
 */
const TEXRA_PREFIX = 'texra.';

export interface ConfigKeyValueStore {
  has(key: string): boolean;
  get<T>(key: string): T | undefined;
}

export interface ConfigWatcherDisposable {
  dispose(): void;
}

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

function keyMatchesChange(key: string, changedKey: string): boolean {
  return configKeyVariants(key).some(
    (candidate) =>
      changedKey === candidate || changedKey.startsWith(`${candidate}.`),
  );
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
    return keyMatchesChange(watcherKey, changedKey);
  }
  if (watcherKey instanceof RegExp) {
    return watcherKey.test(changedKey);
  }
  if (Array.isArray(watcherKey)) {
    return watcherKey.some((item) => keyMatchesChange(item, changedKey));
  }
  return false;
}

export function firstStoredValue<T>(
  store: ConfigKeyValueStore,
  keys: readonly string[],
): T | undefined {
  for (const candidate of keys) {
    if (store.has(candidate)) return store.get<T>(candidate);
  }
  return undefined;
}

export function createWatcherRegistry(): {
  add(watcher: ConfigWatcher): ConfigWatcherDisposable;
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
