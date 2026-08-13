/**
 * Shared TeXRA configuration key helpers.
 *
 * Hosts store settings as flat `texra.<key>` entries. Callers may pass either
 * spelling to the configuration API; storage always uses the canonical key.
 */
const TEXRA_PREFIX = 'texra.';

export function stripPrefix(key: string): string {
  return key.startsWith(TEXRA_PREFIX) ? key.slice(TEXRA_PREFIX.length) : key;
}

export function canonicalConfigKey(key: string): string {
  return `${TEXRA_PREFIX}${stripPrefix(key)}`;
}

function keyMatchesChange(key: string, changedKey: string): boolean {
  const watchedKey = canonicalConfigKey(key);
  const canonicalChangedKey = canonicalConfigKey(changedKey);
  return (
    canonicalChangedKey === watchedKey ||
    canonicalChangedKey.startsWith(`${watchedKey}.`)
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
  return watcherKey.some((item) => keyMatchesChange(item, changedKey));
}

export function createWatcherRegistry(): {
  add(watcher: ConfigWatcher): { dispose(): void };
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
