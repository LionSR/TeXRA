// Local imports
import { createLog } from '@logger/logUtils';
import type {
  ConfigProvider,
  ConfigTarget,
  StateStore,
} from '@platform/interfaces';
import type {
  SettingStore,
  StateSettingEntry,
} from '@shared/schemas/stateSettings';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('settingsAccess');

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

/**
 * The storage slot a setting resolves to for a host: the CLI's `cliStore`
 * override when set, otherwise the canonical `store`. Single source of the
 * resolution rule — display labels and read/write all go through it.
 */
export function settingSlot(
  entry: StateSettingEntry,
  host: SettingsHostKind,
): SettingStore {
  return host === 'cli' && entry.cliStore ? entry.cliStore : entry.store;
}

/** The default-when-absent value for an entry, from its `.prefault()`. */
export function settingDefault(entry: StateSettingEntry): unknown {
  return entry.schema.parse(undefined);
}

/**
 * Read a state-backed setting, falling back to (and validating against) the
 * entry's schema. A stored value that no longer validates resolves to the
 * default rather than propagating a stale/invalid value — but only after
 * warning, matching `getValidatedConfig`'s #7470 fix: an invalid *persisted*
 * value (as opposed to simply absent, which returns above) must not vanish
 * without a trace. Both `ConfigProvider` and `StateStore` expose the same
 * `get(key, default)`, so the read dispatches uniformly on the resolved slot.
 */
export function readSetting(
  entry: StateSettingEntry,
  stores: SettingsStores,
  host: SettingsHostKind = 'extension',
): unknown {
  const raw = stores[settingSlot(entry, host)].get<unknown>(entry.key);
  if (raw === undefined) {
    return settingDefault(entry);
  }
  const normalized = entry.normalizePersisted
    ? entry.normalizePersisted(raw)
    : raw;
  const result = entry.schema.safeParse(normalized);
  if (result.success) {
    return result.data;
  }
  log.warn(
    `Ignoring invalid persisted value for setting "${entry.key}": ${toErrorMessage(result.error)}`,
  );
  return settingDefault(entry);
}

/**
 * Persist a value to an entry's resolved slot. The only slot-specific detail is
 * that `config` writes carry a target while state stores do not, so the
 * dispatch lives here once for both write and reset.
 */
function writeSlot(
  entry: StateSettingEntry,
  value: unknown,
  stores: SettingsStores,
  host: SettingsHostKind,
  target: ConfigTarget | undefined,
): Promise<void> {
  const slot = settingSlot(entry, host);
  return Promise.resolve(
    slot === 'config'
      ? stores.config.update(
          entry.key,
          value,
          target ?? entry.configTarget ?? 'workspace',
        )
      : stores[slot].update(entry.key, value),
  );
}

/**
 * Validate and persist a state-backed setting. Throws if `value` fails the
 * entry's schema. Config-backed settings use the target declared by their
 * catalog row, falling back to `'workspace'`; an explicit caller target wins.
 * State-store slots ignore target.
 */
export async function writeSetting(
  entry: StateSettingEntry,
  value: unknown,
  stores: SettingsStores,
  host: SettingsHostKind = 'extension',
  target?: ConfigTarget,
): Promise<void> {
  // `async` so a schema-rejected value surfaces as a rejected promise rather
  // than a synchronous throw — callers rely on the uniform promise contract.
  await writeSlot(entry, entry.schema.parse(value), stores, host, target);
}

/**
 * Reset a state-backed setting to its default by **deleting** the stored key
 * (`update(key, undefined)`), so the schema's `.prefault()` reappears on the
 * next read. Never writes the literal default value.
 */
export function resetSetting(
  entry: StateSettingEntry,
  stores: SettingsStores,
  host: SettingsHostKind = 'extension',
  target?: ConfigTarget,
): Promise<void> {
  return writeSlot(entry, undefined, stores, host, target);
}
