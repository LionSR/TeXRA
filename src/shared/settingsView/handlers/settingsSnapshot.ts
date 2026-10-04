import { Effect } from 'effect';
/**
 * The one builder for every catalog-derived settings-view snapshot.
 *
 * A snapshot is exactly "the catalog rows tagged for it", so this reads that
 * list rather than naming fields: the approval/safety, git-author, skills,
 * telemetry, agents, and LaTeX snapshots all come from here. Per-row defaults,
 * validation and storage slots already live on the
 * catalog row and are applied by `readSetting`, so a snapshot builder has
 * nothing left of its own to say.
 */
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { TEXRA_SETTINGS } from '@shared/settingsView/texraSettings';
import type { DerivedSettingsSnapshot } from '@shared/settingsView/settingsViewMessages';
import {
  readSetting,
  type SettingsStores,
} from '@shared/config/settingsAccess';

/** Read one settings-view snapshot from the host's stores. */
export function buildSettingsSnapshotMessage(
  snapshot: DerivedSettingsSnapshot,
  stores: SettingsStores,
) {
  return Effect.gen(function* () {
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_SETTINGS_SNAPSHOT,
      snapshot,
      values: Object.fromEntries(
        yield* Effect.forEach(
          TEXRA_SETTINGS.snapshotEntries(snapshot),
          (entry) =>
            readSetting(entry, stores).pipe(
              Effect.map((value) => [entry.key, value] as const),
            ),
        ),
      ),
    };
  });
}
