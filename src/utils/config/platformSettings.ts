import type { ConfigTarget, ConfigWriteFailed } from '@platform/interfaces';
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
 * {@link readSettingFrom} over the calling context's roots, for the callers
 * that hold no workspace of their own: the git-author environment assembled
 * inside `executeCommand`, the worktree opt-in read inside a Zod transform,
 * and the provider-config readers. Code that holds its roots — a tool call, a
 * run, a session, a host command — reads through {@link readSettingFrom}
 * instead.
 *
 * Resolves the setting's default from the entry's schema `.prefault()` — the
 * single default source.
 *
 * Replaces the scattered per-store `get(key, handPassedDefault)` reads
 * whose second argument duplicated the catalog default: the value now comes from
 * the schema, and a stale/invalid stored value snaps back to that default (via
 * `readSetting`'s `safeParse`) rather than propagating. The store slot
 * (`workspaceState` / `globalState` / `config`) is the one the catalog entry
 * declares for this process's host, so the right backing store is picked
 * without the caller naming it. Host-specific convenience readers remain
 * preferable when they also own normalization or side effects.
 */
export function readPlatformSetting<T>(key: string): T {
  return readSettingFrom<T>(platformSettingsStores(), key);
}

/**
 * The one catalog reader: a setting read from the three slots the caller holds
 * as data. A session's `WorkspaceRoots` carries all three, so a tool call's
 * `call.roots`, a run's `session.roots` and a host command's `session.roots`
 * are passed directly, and the value answers for that project rather than for
 * whichever roots the calling fiber happens to carry.
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
  return writeSettingTo(platformSettingsStores(), key, value);
}

/**
 * {@link writePlatformSetting} over stores the caller already holds — the
 * write-side counterpart of {@link readSettingFrom}, resolving the same slot
 * from the same catalog row and applying the same `onWrite` effects. A caller
 * that reads a setting from its own roots writes it back through here, so the
 * read and the write cannot answer for two different workspaces.
 *
 * `target` overrides the config scope a config-slot row is written to, for the
 * one caller that keeps a value in whichever scope already holds it (the
 * "prefer my subscription" switches); state-slot rows ignore it.
 */
export function writeSettingTo(
  stores: SettingsStores,
  key: string,
  value: unknown,
  target?: ConfigTarget,
): Effect.Effect<void, ConfigWriteFailed | Error> {
  return writeSetting(
    requireEntry(key),
    value,
    stores,
    processSettingHost,
    target,
  );
}
