import { Effect } from 'effect';

import type {
  SettingsCatalog,
  StateSettingEntry,
} from '@shared/state/stateSettings';
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
  set(key: string, value: unknown): Effect.Effect<void, Error>;
}

export interface JsonConfigProviderOptions {
  workspace: ConfigStore;
  global: ConfigStore;
  /** This user's private store for the workspace; see {@link ConfigTarget}. */
  local: ConfigStore;
  /** The rows the stores' keys resolve against (`ConfigProvider.catalog`). */
  catalog: SettingsCatalog;
}

/**
 * Whether a project file's `value` for a key of catalog row `row` is ignored:
 * the one scope rule every read and the open-time warning share. A row the
 * catalog leaves at the workspace scope reads its project value; a `global` or
 * `local` row (the approval settings) does not, so a cloned repository cannot
 * set it, except that a `projectMayOptOut` row (telemetry) still takes
 * anything but `true`.
 */
export function projectValueIgnored(
  row: StateSettingEntry | undefined,
  value: unknown,
): boolean {
  if ((row?.configTarget ?? 'workspace') === 'workspace') return false;
  return row?.projectMayOptOut !== true || value === true;
}

/**
 * Store-backed {@link ConfigProvider}. Keys are relative to the catalog's
 * namespace and stored flat under it (`<namespace>.<key>`). Workspace values
 * shadow global values on read and `update()` routes writes by {@link ConfigTarget}. The project file answers
 * only where {@link projectValueIgnored} lets it; past it, `local` shadows
 * `global` for `local` rows, and `global` alone answers for the others.
 */
export class JsonConfigProvider implements ConfigProvider {
  private readonly workspaceStore: ConfigStore;
  private readonly globalStore: ConfigStore;
  private readonly localStore: ConfigStore;
  readonly catalog: SettingsCatalog;

  constructor({
    workspace,
    global,
    local,
    catalog,
  }: JsonConfigProviderOptions) {
    this.workspaceStore = workspace;
    this.globalStore = global;
    this.localStore = local;
    this.catalog = catalog;
  }

  private storedKey(key: string): string {
    return `${this.catalog.namespace}.${key}`;
  }

  get<T>(key: string): T {
    const storedKey = this.storedKey(key);
    const row = this.catalog.byKey(key);
    const projectValue = this.workspaceStore.get<T>(storedKey);
    if (projectValue !== undefined && !projectValueIgnored(row, projectValue)) {
      return projectValue;
    }
    const layers =
      row?.configTarget === 'local'
        ? [this.localStore, this.globalStore]
        : [this.globalStore];
    for (const store of layers) {
      const value = store.get<T>(storedKey);
      if (value !== undefined) return value;
    }
    // cast: the caller names the value type of the key it reads.
    return this.catalog.configDefault(key) as T;
  }

  update<T>(
    key: string,
    value: T,
    target: ConfigTarget = 'workspace',
  ): Effect.Effect<void, ConfigWriteFailed> {
    const store = {
      global: this.globalStore,
      local: this.localStore,
      workspace: this.workspaceStore,
    }[target];
    const storedKey = this.storedKey(key);
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

  inspect<T = unknown>(key: string): ConfigInspection<T> {
    const storedKey = this.storedKey(key);
    return {
      globalValue: this.globalStore.get<T>(storedKey),
      workspaceValue: this.workspaceStore.get<T>(storedKey),
    };
  }
}
