/**
 * The one builder for every catalog-derived settings-view snapshot.
 *
 * A snapshot is exactly "the catalog rows tagged for it", so this reads that
 * list rather than naming fields: the approval/safety, git-author, agent-skills,
 * telemetry, and multi-agent snapshots all come from here. Per-row defaults,
 * validation, storage slot, and legacy normalization already live on the
 * catalog row and are applied by `readSetting`, so a snapshot builder has
 * nothing left of its own to say.
 */
import {
  SETTINGS_SNAPSHOT_COMMANDS,
  settingsViewSnapshotEntries,
  type DerivedSettingsSnapshot,
  type SettingHost,
  type SettingsSnapshotValues,
} from '@shared/schemas';
import {
  readSetting,
  type SettingsStores,
} from '@shared/config/settingsAccess';

/** A catalog-derived snapshot message, ready to post to the settings webview. */
export interface SettingsSnapshotMessage {
  readonly command: (typeof SETTINGS_SNAPSHOT_COMMANDS)[DerivedSettingsSnapshot];
  readonly values: SettingsSnapshotValues;
}

/** Read one settings-view snapshot from the host's stores. */
export function buildSettingsSnapshotMessage(
  snapshot: DerivedSettingsSnapshot,
  stores: SettingsStores,
  host: SettingHost,
): SettingsSnapshotMessage {
  return {
    command: SETTINGS_SNAPSHOT_COMMANDS[snapshot],
    values: Object.fromEntries(
      settingsViewSnapshotEntries(snapshot).map((entry) => [
        entry.key,
        readSetting(entry, stores, host),
      ]),
    ),
  };
}
