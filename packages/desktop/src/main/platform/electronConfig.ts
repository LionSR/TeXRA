import { JsonStore } from './jsonStore.js';
import type {
  ConfigInspection,
  ConfigProvider,
  ConfigTarget,
} from '@platform/interfaces/config';
import type { Disposable } from '@platform/interfaces/disposable';

type ConfigWatcher = {
  key: string | readonly string[] | RegExp;
  listener: () => void;
};

function configKeys(key: string): string[] {
  const unprefixed = key.startsWith('texra.')
    ? key.slice('texra.'.length)
    : key;
  return [unprefixed, `texra.${unprefixed}`];
}

function canonicalConfigKey(key: string): string {
  const unprefixed = key.startsWith('texra.')
    ? key.slice('texra.'.length)
    : key;
  return `texra.${unprefixed}`;
}

function matchesConfigKey(candidate: string, changedKey: string): boolean {
  return changedKey === candidate || changedKey.startsWith(`${candidate}.`);
}

function watcherMatches(
  watcherKey: ConfigWatcher['key'],
  changedKey: string,
): boolean {
  if (typeof watcherKey === 'string') {
    return configKeys(watcherKey).some((candidate) =>
      matchesConfigKey(candidate, changedKey),
    );
  }
  if (watcherKey instanceof RegExp) {
    return watcherKey.test(changedKey);
  }
  if (Array.isArray(watcherKey)) {
    return watcherKey.some((item) =>
      configKeys(item).some((candidate) =>
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

export class ElectronConfigProvider implements ConfigProvider {
  private readonly watchers = new Set<ConfigWatcher>();

  constructor(
    private readonly globalStore: JsonStore,
    private readonly workspaceStore: JsonStore,
  ) {}

  get<T>(key: string, defaultValue?: T): T {
    const keys = configKeys(key);
    const workspaceValue = firstStoredValue<T>(this.workspaceStore, keys);
    if (workspaceValue !== undefined) return workspaceValue;
    const globalValue = firstStoredValue<T>(this.globalStore, keys);
    if (globalValue !== undefined) return globalValue;
    return defaultValue as T;
  }

  async update<T>(
    key: string,
    value: T,
    target: ConfigTarget = 'workspace',
  ): Promise<void> {
    const store = target === 'global' ? this.globalStore : this.workspaceStore;
    const keys = configKeys(key);
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
    for (const watcher of this.watchers) {
      if (keys.some((changedKey) => watcherMatches(watcher.key, changedKey))) {
        watcher.listener();
      }
    }
  }

  inspect<T = unknown>(key: string): ConfigInspection<T> | undefined {
    const keys = configKeys(key);
    return {
      globalValue: firstStoredValue<T>(this.globalStore, keys),
      workspaceValue: firstStoredValue<T>(this.workspaceStore, keys),
      effectiveValue: this.get<T>(key),
    };
  }

  isExplicitlySet(key: string): boolean {
    return configKeys(key).some(
      (candidate) =>
        this.globalStore.has(candidate) || this.workspaceStore.has(candidate),
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
