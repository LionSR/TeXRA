import { platform } from '@platform/platform';
import { workspaceRoots } from '@platform/workspaceRoots';
import { settingByKey, type SettingHost } from '@shared/schemas';
import {
  readSetting,
  writeSetting,
  type SettingsStores,
} from '@shared/config/settingsAccess';

function requireEntry(key: string) {
  const entry = settingByKey(key);
  if (!entry) {
    throw new Error(`No setting catalog entry for key: ${key}`);
  }
  return entry;
}

/**
 * The host this process is, for the catalog rows whose storage slot differs
 * by host (the git identity and skill availability rows live in workspace
 * state on the extension and desktop and in `.texra/config.json` on the
 * CLI). One process is one host, so the composition root installs it once,
 * beside `initProcessWorkspaceRoots()`.
 */
let processSettingHost: SettingHost = 'vscode';

export function initProcessSettingHost(host: SettingHost): void {
  processSettingHost = host;
}

/**
 * The three setting slots for the calling context: the session's workspace
 * config and state, and the process global state. `settingsAccess` resolves
 * `entry.slots[host]` per row over these, so the git-author keys read and
 * write `.texra/config.json` (config) on the CLI while other state-backed
 * keys use the state stores.
 */
export function platformSettingsStores(): SettingsStores {
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
 * declares for this process's host, so the right backing store is picked
 * without the caller naming it. Host-specific convenience readers remain
 * preferable when they also own normalization or side effects.
 */
export function readPlatformSetting<T>(key: string): T {
  return readSetting(
    requireEntry(key),
    platformSettingsStores(),
    processSettingHost,
  ) as T;
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
  return writeSetting(
    requireEntry(key),
    value,
    platformSettingsStores(),
    processSettingHost,
  );
}
