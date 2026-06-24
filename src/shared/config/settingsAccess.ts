// Local imports - catalog + platform interfaces (type-only; vscode-free)
import type {
  SettingStore,
  StateSettingEntry,
} from '@shared/schemas/stateSettings';
import type { ConfigProvider, ConfigTarget } from '@platform/interfaces/config';
import type { StateStore } from '@platform/interfaces/state';

/**
 * Host-aware read/write for {@link StateSettingEntry} rows.
 *
 * Both `ConfigProvider` and `StateStore` expose the same `get(key, default)`
 * read surface, so reads dispatch uniformly. Writes differ (`ConfigProvider`
 * takes a target; `StateStore` does not), so they branch on the resolved slot.
 *
 * The resolved slot is `entry.cliStore ?? entry.store` for the CLI and
 * `entry.store` for the extension/desktop — the git-author keys are the only
 * rows that diverge (extension WorkspaceState vs CLI `.texra/config.json`).
 */

export interface SettingsStores {
  readonly config: ConfigProvider;
  readonly workspaceState: StateStore;
  readonly globalState: StateStore;
}

export type SettingsHostKind = 'extension' | 'cli';

interface KeyValueReader {
  get<T>(key: string, defaultValue?: T): T;
}

function slotFor(
  entry: StateSettingEntry,
  host: SettingsHostKind,
): SettingStore {
  return host === 'cli' && entry.cliStore ? entry.cliStore : entry.store;
}

function readerFor(slot: SettingStore, stores: SettingsStores): KeyValueReader {
  // ConfigProvider and StateStore both satisfy KeyValueReader.
  return stores[slot] as unknown as KeyValueReader;
}

/** The default-when-absent value for an entry, from its `.prefault()`. */
export function settingDefault(entry: StateSettingEntry): unknown {
  return entry.schema.parse(undefined);
}

/**
 * Read a state-backed setting, falling back to (and validating against) the
 * entry's schema. A stored value that no longer validates resolves to the
 * default rather than propagating a stale/invalid value.
 */
export function readSetting(
  entry: StateSettingEntry,
  stores: SettingsStores,
  host: SettingsHostKind = 'extension',
): unknown {
  const fallback = settingDefault(entry);
  const raw = readerFor(slotFor(entry, host), stores).get<unknown>(entry.key);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = entry.schema.safeParse(raw);
  return parsed.success ? parsed.data : fallback;
}

/**
 * Validate and persist a state-backed setting. Throws if `value` fails the
 * entry's schema. For `config`-slot writes the target defaults to `'workspace'`
 * (matching today's CLI git-author behavior); state-store slots ignore target.
 */
export async function writeSetting(
  entry: StateSettingEntry,
  value: unknown,
  stores: SettingsStores,
  host: SettingsHostKind = 'extension',
  target: ConfigTarget = 'workspace',
): Promise<void> {
  const parsed = entry.schema.parse(value);
  const slot = slotFor(entry, host);
  if (slot === 'config') {
    await stores.config.update(entry.key, parsed, target);
  } else {
    await stores[slot].update(entry.key, parsed);
  }
}

/**
 * Reset a state-backed setting to its default by **deleting** the stored key
 * (`update(key, undefined)`), so the schema's `.prefault()` reappears on the
 * next read. Never writes the literal default value.
 */
export async function resetSetting(
  entry: StateSettingEntry,
  stores: SettingsStores,
  host: SettingsHostKind = 'extension',
  target: ConfigTarget = 'workspace',
): Promise<void> {
  const slot = slotFor(entry, host);
  if (slot === 'config') {
    await stores.config.update(entry.key, undefined, target);
  } else {
    await stores[slot].update(entry.key, undefined);
  }
}
