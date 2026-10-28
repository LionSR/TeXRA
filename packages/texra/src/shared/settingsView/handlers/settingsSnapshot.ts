import { Settings } from '@texra-ai/harness/host';
import { Effect } from 'effect';
/**
 * The one builder for every catalog-derived settings-view snapshot.
 *
 * A snapshot is exactly "the catalog rows tagged for it", so this reads that
 * list rather than naming fields: the approval/safety, git-author, skills,
 * telemetry, agents, and LaTeX snapshots all come from here. Per-row defaults,
 * validation and storage slots already live on the
 * catalog row and are applied by `Settings.get`, so a snapshot builder has
 * nothing left of its own to say.
 */
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import type { DerivedSettingsSnapshot } from '@texra/shared/settingsView/settingsViewMessages';
import type { SettingsStores } from '@texra-ai/harness/host';

/** Read one settings-view snapshot from the host's stores. */
export const buildSettingsSnapshotMessage = Effect.fn(
  'buildSettingsSnapshotMessage',
)(function* (snapshot: DerivedSettingsSnapshot, stores: SettingsStores) {
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_SETTINGS_SNAPSHOT,
    snapshot,
    values: Object.fromEntries(
      yield* Effect.forEach(TEXRA_SETTINGS.snapshotEntries(snapshot), (entry) =>
        Settings.get(stores, entry.key).pipe(
          Effect.map((value) => [entry.key, value] as const),
        ),
      ),
    ),
  };
});
