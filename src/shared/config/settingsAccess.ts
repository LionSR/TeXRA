// Local imports
import { createLog } from '@logger/logUtils';
import type {
  ConfigProvider,
  ConfigTarget,
  StateStore,
} from '@platform/interfaces';
import type {
  SettingHost,
  SettingStore,
  StateSettingEntry,
} from '@shared/schemas';
import { settingByKey } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('settingsAccess');

/**
 * Host-aware read/write for {@link StateSettingEntry} rows.
 *
 * Both `ConfigProvider` and `StateStore` expose the same `get(key, default)`
 * read surface, so reads dispatch uniformly. Writes differ (`ConfigProvider`
 * takes a target; `StateStore` does not), so they branch on the resolved slot.
 *
 * The slot is whatever the row's `slots` map declares for the calling host —
 * there is no fallback chain, so a host that does not store a setting cannot
 * silently read someone else's slot.
 */

export interface SettingsStores {
  readonly config: ConfigProvider;
  readonly workspaceState: StateStore;
  readonly globalState: StateStore;
}

/**
 * The storage slot a setting resolves to for a host. Single source of the
 * resolution rule — display labels and read/write all go through it. Throws
 * when the row declares no slot for the host: a silent fallback would write
 * the value where that host will never read it back.
 */
export function settingSlot(
  entry: StateSettingEntry,
  host: SettingHost,
): SettingStore {
  const slot = entry.slots[host];
  if (slot === undefined) {
    throw new Error(`Setting "${entry.key}" has no ${host} storage slot`);
  }
  return slot;
}

/** The default-when-absent value for an entry, from its `.prefault()`. */
export function settingDefault(entry: StateSettingEntry): unknown {
  return entry.schema.parse(undefined);
}

/** Keys already reported, so a per-call reader warns once per process. */
const abandonedSlotWarned = new Set<string>();

/**
 * Report, once per key per process, that a value survives in a slot the row has
 * migrated away from.
 *
 * Intermediate-era persisted data is disposable here, so a slot migration
 * abandons whatever the old slot held rather than shipping a compat reader that
 * outlives its purpose. Abandoning it *silently* is the defect: to the user the
 * toggle simply reverts, with nothing anywhere saying why. Called from the
 * runtime reader — the moment the old value would have changed the outcome.
 */
export function warnAbandonedSlotValue(
  key: string,
  abandonedSlot: SettingStore,
  abandonedStore: StateStore,
): void {
  if (abandonedSlotWarned.has(key)) return;
  abandonedSlotWarned.add(key);
  if (abandonedStore.get(key) === undefined) return;
  log.warn(
    `Setting "${key}" changed storage slot; the value still held in ${abandonedSlot} is abandoned and will not be migrated. Set it again if you had changed it.`,
  );
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
  host: SettingHost = 'vscode',
): unknown {
  const slot = settingSlot(entry, host);
  // Read the scope the row is written to: `writeSetting` targets
  // `entry.configTarget`, so a global-target row read through the merged
  // `get()` could report a workspace value the settings view can never write.
  const raw =
    slot === 'config' && entry.configTarget === 'global'
      ? stores.config.inspect<unknown>(entry.key)?.globalValue
      : stores[slot].get<unknown>(entry.key);
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
  host: SettingHost,
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
 * Validate and persist a state-backed setting, then apply the row's declared
 * write effects. Throws if `value` fails the entry's schema. Config-backed
 * settings use the target declared by their catalog row, falling back to
 * `'workspace'`; an explicit caller target wins. State-store slots ignore
 * target.
 *
 * `onWrite.disablesWhenEnabled` is applied here rather than in each host's
 * form so mutually exclusive routes (Kimi Code vs OpenRouter) cannot be
 * enforced on one write path and skipped on another. The excluded rows are
 * written directly — their own effects do not cascade, which is what keeps the
 * rule a single hop.
 */
export async function writeSetting(
  entry: StateSettingEntry,
  value: unknown,
  stores: SettingsStores,
  host: SettingHost = 'vscode',
  target?: ConfigTarget,
): Promise<void> {
  // `async` so a schema-rejected value surfaces as a rejected promise rather
  // than a synchronous throw — callers rely on the uniform promise contract.
  await writeSlot(entry, entry.schema.parse(value), stores, host, target);
  if (value !== true) return;
  for (const excludedKey of entry.onWrite?.disablesWhenEnabled ?? []) {
    const excluded = settingByKey(excludedKey);
    if (!excluded) {
      throw new Error(
        `Setting "${entry.key}" excludes unknown setting "${excludedKey}"`,
      );
    }
    await writeSlot(excluded, false, stores, host, target);
  }
}

/**
 * Reset a state-backed setting to its default by **deleting** the stored key
 * (`update(key, undefined)`), so the schema's `.prefault()` reappears on the
 * next read. Never writes the literal default value.
 */
export function resetSetting(
  entry: StateSettingEntry,
  stores: SettingsStores,
  host: SettingHost = 'vscode',
  target?: ConfigTarget,
): Promise<void> {
  return writeSlot(entry, undefined, stores, host, target);
}
