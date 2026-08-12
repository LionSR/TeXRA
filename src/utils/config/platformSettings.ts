import { tryPlatform } from '@platform/platform';
import { readSetting, settingDefault } from '@shared/config/settingsAccess';
import { stateSettingByKey } from '@shared/schemas/stateSettings';

/**
 * Read a catalog-modeled state setting from the live platform, resolving its
 * default from the entry's schema `.prefault()` — the single default source.
 *
 * Replaces the scattered `platform().<store>.get(key, handPassedDefault)` reads
 * whose second argument duplicated the catalog default: the value now comes from
 * the schema, and a stale/invalid stored value snaps back to that default (via
 * `readSetting`'s `safeParse`) rather than propagating. The store slot
 * (`workspaceState` / `globalState` / `config`) is the one the catalog entry
 * declares, so the right backing store is picked without the caller naming it.
 *
 * Graceful when the platform isn't initialized yet — returns the schema default
 * instead of throwing — matching the previous `tryWorkspaceState()?.get(...) ??
 * default` sites. Reads resolve to the `'extension'` host slot: the CLI-divergent
 * git-author keys (`cliStore: 'config'`) are read through the CLI's own
 * `readGitAuthorSettingsFromState`, and no current caller passes a host — the
 * CLI `settingSlot` branch had no consumer and was removed.
 */
export function readPlatformSetting<T>(key: string): T {
  const entry = stateSettingByKey(key);
  if (!entry) {
    throw new Error(`No state-setting catalog entry for key: ${key}`);
  }
  const active = tryPlatform();
  if (!active) {
    return settingDefault(entry) as T;
  }
  // `Platform` structurally supplies the `config`/`workspaceState`/`globalState`
  // slots `readSetting` reads from, so it passes as `SettingsStores` directly.
  // `readSetting`'s `host` defaults to `'extension'`.
  return readSetting(entry, active) as T;
}
