import type { ConfigWriteFailed } from '@platform/interfaces';
import { workspaceRoots } from '@platform/workspaceRoots';
import { settingByKey, type SettingHost } from '@shared/schemas';
import {
  readSetting,
  writeSetting,
  type SettingsStores,
} from '@shared/config/settingsAccess';
import type { Effect } from 'effect';

function requireEntry(key: string) {
  const entry = settingByKey(key);
  if (!entry) {
    throw new Error(`No setting catalog entry for key: ${key}`);
  }
  return entry;
}

/**
 * The host this process is, for the catalog rows whose storage slot differs
 * by host (the git identity rows live in worktree-shared workspace state on
 * the extension and desktop and in `.texra/config.json` on the CLI). One
 * process is one host, so the composition root installs it once, beside
 * `initProcessWorkspaceRoots()`.
 */
let processSettingHost: SettingHost = 'vscode';

export function initProcessSettingHost(host: SettingHost): void {
  processSettingHost = host;
}

/** The host this process is, as installed by {@link initProcessSettingHost}. */
export function getProcessSettingHost(): SettingHost {
  return processSettingHost;
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
    globalState: roots.globalState,
  };
}

/**
 * Read a catalog-modeled setting from the live platform, resolving its default
 * from the entry's schema `.prefault()` — the single default source.
 *
 * Replaces the scattered per-store `get(key, handPassedDefault)` reads
 * whose second argument duplicated the catalog default: the value now comes from
 * the schema, and a stale/invalid stored value snaps back to that default (via
 * `readSetting`'s `safeParse`) rather than propagating. The store slot
 * (`workspaceState` / `globalState` / `config`) is the one the catalog entry
 * declares for this process's host, so the right backing store is picked
 * without the caller naming it. Host-specific convenience readers remain
 * preferable when they also own normalization or side effects.
 *
 * Prefer this over `configUtils.ts`'s `getConfig`/`readConfig` for a
 * catalog-modeled key whose slot is `workspaceState`/`globalState` for this
 * host: those read the config-tree slot only, skip schema validation unless
 * the caller opts into `getValidatedConfig`, and cannot see such a key at
 * all. `getConfig`/`readConfig`/`getValidatedConfig` remain the right tool
 * for a config-tree value the catalog does not model, and — this function's
 * one carve-out — for a catalog-modeled `configTarget: 'global'` config-slot
 * key whose runtime must honor a workspace override (the Models-tab provider
 * toggles; see the note above `model.gpt5ReasoningSummary` in
 * `stateSettings.ts` and their `readConfig` call sites in `modelBinding.ts`):
 * this function resolves such a row to `inspect(key).globalValue` only and
 * would silently drop the override.
 */
export function readPlatformSetting<T>(key: string): T {
  return readSettingFrom<T>(platformSettingsStores(), key);
}

/**
 * {@link readPlatformSetting} over stores the caller already holds — a run's
 * session roots carry all three slots. Code that holds its roots as data (a
 * run's Effect program, which is not guaranteed to sit inside its session's
 * roots scope) reads through this instead of the calling context's scope.
 */
export function readSettingFrom<T>(stores: SettingsStores, key: string): T {
  return readSetting(requireEntry(key), stores, processSettingHost) as T;
}

/**
 * Write a catalog-modeled setting through the shared write path, so the row's
 * schema validation and its declared `onWrite` effects apply to runtime callers
 * as well as to the settings UIs.
 *
 * A value the row's schema rejects is a defect of the program, not a member of
 * the declared `ConfigWriteFailed | Error` channel: it is raised inside
 * `writeSetting`, so it will not arrive as a catchable failure. Callers must
 * pass a value they already know is valid. User input is validated upstream — a
 * setting write resolves through `resolveStateSettingWrite`, which `safeParse`s
 * before reaching the shared path — and a malformed catalog row is a bug to
 * fix rather than a condition to catch.
 */
export function writePlatformSetting(
  key: string,
  value: unknown,
): Effect.Effect<void, ConfigWriteFailed | Error> {
  return writeSetting(
    requireEntry(key),
    value,
    platformSettingsStores(),
    processSettingHost,
  );
}
