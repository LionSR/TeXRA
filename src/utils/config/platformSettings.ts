import type {
  ConfigProvider,
  ConfigTarget,
  ConfigWriteFailed,
  StateReadFailed,
} from '@platform/interfaces';
import { settingByKey, type SettingHost } from '@shared/state/stateSettings';
import {
  inspectSetting,
  readConfigSetting,
  readSetting,
  writeSetting,
  type SettingsStores,
  type StoredSetting,
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
 * `initPlatform()`.
 */
let installedHost: SettingHost | undefined;

export function initProcessSettingHost(host: SettingHost): void {
  installedHost = host;
}

/** Setting slots keep their extension layout until a root names the host. */
const processSettingHost = (): SettingHost => installedHost ?? 'vscode';

/**
 * The same host in the tool registry's naming, for `unavailableHosts`, or
 * `undefined` when no composition root named one (the agent package embedded
 * in another process, a test). The tool resolver withholds every host-bound
 * tool from such a process rather than guessing which host it is.
 */
export function processToolHost(): 'cli' | 'desktop' | 'extension' | undefined {
  return installedHost === 'vscode' ? 'extension' : installedHost;
}

/**
 * The one catalog reader: a setting read from the three slots the caller holds
 * as data. A session's `WorkspaceRoots` carries all three, so a tool call's
 * `call.roots`, a run's `session.roots` and a host command's `session.roots`
 * are passed directly, and the value answers for that project rather than for
 * whichever roots the calling fiber happens to carry.
 */
export function readSettingFrom<T>(
  stores: SettingsStores,
  key: string,
): Effect.Effect<T, StateReadFailed> {
  return readSetting(
    requireEntry(key),
    stores,
    processSettingHost(),
  ) as Effect.Effect<T, StateReadFailed>;
}

/**
 * {@link readSettingFrom} that reports a present value failing the row's
 * schema as `invalid` instead of resolving it to the row's default.
 */
export function inspectSettingFrom<T>(
  stores: SettingsStores,
  key: string,
): Effect.Effect<StoredSetting<T>, StateReadFailed> {
  return inspectSetting(
    requireEntry(key),
    stores,
    processSettingHost(),
  ) as Effect.Effect<StoredSetting<T>, StateReadFailed>;
}

/** Read and validate one catalog-backed value from its config slot. */
export function readConfigSettingFrom<T>(
  config: ConfigProvider,
  key: string,
): T {
  return readConfigSetting(requireEntry(key), config) as T;
}

/**
 * Write a catalog-modeled setting to the stores the caller already holds — the
 * write-side counterpart of {@link readSettingFrom}, resolving the same slot
 * from the same catalog row and applying the same `onWrite` effects. A caller
 * that reads a setting from its own roots writes it back through here, so the
 * read and the write cannot answer for two different workspaces, and the row's
 * schema validation applies to runtime callers as well as to the settings UIs.
 *
 * A value the row's schema rejects is a defect of the program, not a member of
 * the declared `ConfigWriteFailed | Error` channel: it is raised inside
 * `writeSetting`, so it will not arrive as a catchable failure. Callers must
 * pass a value they already know is valid. User input is validated upstream — a
 * setting write resolves through `applyStateSettingUpdate`, which `safeParse`s
 * before reaching the shared path — and a malformed catalog row is a bug to
 * fix rather than a condition to catch.
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
    processSettingHost(),
    target,
  );
}
