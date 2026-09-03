import { platform } from '@platform/platform';
import { workspaceRoots } from '@platform/workspaceRoots';
import { settingByKey, type SettingHost } from '@shared/schemas';
import { readSetting, writeSetting } from '@shared/config/settingsAccess';

function requireEntry(key: string) {
  const entry = settingByKey(key);
  if (!entry) {
    throw new Error(`No setting catalog entry for key: ${key}`);
  }
  return entry;
}

/**
 * The three setting slots for the calling context: the session's workspace
 * config and state, and the process global state.
 */
function settingsStores() {
  const roots = workspaceRoots();
  return {
    config: roots.config,
    workspaceState: roots.workspaceState,
    globalState: platform().globalState,
  };
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
 * Reads default to the `'vscode'` slot, which most rows share with `desktop`.
 * A host-neutral runtime whose row deliberately diverges by host may pass the
 * active host explicitly; host-specific convenience readers remain preferable
 * when they also own normalization or side effects.
 */
export function readPlatformSetting<T>(
  key: string,
  host: SettingHost = 'vscode',
): T {
  return readSetting(requireEntry(key), settingsStores(), host) as T;
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
  return writeSetting(requireEntry(key), value, settingsStores());
}
