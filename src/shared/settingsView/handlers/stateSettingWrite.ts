// Shared routing decision for the generic `UPDATE_STATE_SETTING` command.
//
// This resolver owns the subtle catalog boundary rules once:
//   - a value-less message is a no-op (the catalog schemas `.prefault()`, so
//     parsing `undefined` would silently write a default),
//   - null explicitly resets a setting while an omitted value remains a no-op,
//   - only catalog rows tagged for a settings-view snapshot are writable.
//
// It performs no I/O and has no host dependency, so it stays in `src/shared`.
// The write orchestration that consumes this decision (persist, guard, fire
// the approval-policy side effect) is host-neutral but not pure, so it lives
// in `@controllers/settingsView/StateSettingUpdateController` instead.

import {
  settingsViewSettingByKey,
  type SettingsViewStateSettingEntry,
} from '@shared/schemas/stateSettings';

/**
 * A validated state-setting write/reset, a rejected catalog value, or `null`
 * when the message must be ignored (value-less, unknown key, or a catalog row
 * this settings view does not own).
 */
export type StateSettingWrite =
  | {
      readonly kind: 'write';
      readonly entry: SettingsViewStateSettingEntry;
      readonly value: unknown;
    }
  | {
      readonly kind: 'reset';
      readonly entry: SettingsViewStateSettingEntry;
    }
  | {
      readonly kind: 'rejected';
      readonly entry: SettingsViewStateSettingEntry;
      readonly error: Error;
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
  if (!entry) return null;
  if (value === null) return { kind: 'reset', entry };
  const parsed = entry.schema.safeParse(value);
  if (!parsed.success) return { kind: 'rejected', entry, error: parsed.error };
  return { kind: 'write', entry, value: parsed.data };
}
