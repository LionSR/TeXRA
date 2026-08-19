import { platform } from '@platform/platform';
import { settingByKey } from '@shared/schemas';
import { readSetting, writeSetting } from '@shared/config/settingsAccess';

function requireEntry(key: string) {
  const entry = settingByKey(key);
  if (!entry) {
    throw new Error(`No setting catalog entry for key: ${key}`);
  }
  return entry;
}

/**
 * Read a catalog-modeled setting from the live platform, resolving its default
 * from the entry's schema `.prefault()` — the single default source.
 *
 * Replaces the scattered `platform().<store>.get(key, handPassedDefault)` reads
 * whose second argument duplicated the catalog default: the value now comes from
 * the schema, and a stale/invalid stored value snaps back to that default (via
 * `readSetting`'s `safeParse`) rather than propagating. The store slot
 * (`workspaceState` / `globalState` / `config`) is the one the catalog entry
 * declares, so the right backing store is picked without the caller naming it.
 *
 * Reads resolve to the `'vscode'` slot, which every row shares with `desktop`;
 * the CLI-divergent git-author keys are read through the CLI's own
 * `readGitAuthorSettingsFromState`.
 */
export function readPlatformSetting<T>(key: string): T {
  // `Platform` structurally supplies the `config`/`workspaceState`/`globalState`
  // slots `readSetting` reads from, so it passes as `SettingsStores` directly.
  return readSetting(requireEntry(key), platform()) as T;
}

/**
 * Write a catalog-modeled setting through the shared write path, so the row's
 * schema validation and its declared `onWrite` effects apply to runtime callers
 * as well as to the settings UIs.
 */
export function writePlatformSetting(
  key: string,
  value: unknown,
): Promise<void> {
  return writeSetting(requireEntry(key), value, platform());
}
