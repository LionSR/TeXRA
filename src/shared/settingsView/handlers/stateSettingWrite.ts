// Shared routing decision for the generic `UPDATE_STATE_SETTING` command.
//
// The extension and desktop hosts share persistence through settingsAccess and
// own only the post-write side effects for each outbound snapshot. This
// resolver owns the subtle boundary rules once:
//   - a value-less message is a no-op (the catalog schemas `.prefault()`, so
//     parsing `undefined` would silently write a default),
//   - null explicitly resets a setting while an omitted value remains a no-op,
//   - only catalog rows tagged for a settings-view snapshot are writable.

import { settingsViewSettingByKey } from '@shared/schemas/stateSettings';
import type { SettingsViewStateSettingEntry } from '@shared/schemas/stateSettings';

/**
 * A validated state-setting write/reset, or `null` when the message must be
 * ignored (value-less, unknown key, schema-rejected value, or a catalog row
 * this settings view does not own).
 */
type StateSettingWrite =
  | {
      readonly kind: 'write';
      readonly entry: SettingsViewStateSettingEntry;
      readonly value: unknown;
    }
  | {
      readonly kind: 'reset';
      readonly entry: SettingsViewStateSettingEntry;
    }
  | null;

/**
 * Validate a `{key, value}` write against the unified settings-view catalog and
 * identify its rebroadcast owner, or return `null` to ignore it. This function
 * performs no I/O.
 */
export function resolveStateSettingWrite(
  key: string,
  value: unknown,
): StateSettingWrite {
  if (value === undefined) return null;
  const entry = settingsViewSettingByKey(key);
  if (!entry?.settingsViewSnapshot) return null;
  if (value === null) return { kind: 'reset', entry };
  const parsed = entry.schema.safeParse(value);
  if (!parsed.success) return null;
  return { kind: 'write', entry, value: parsed.data };
}
