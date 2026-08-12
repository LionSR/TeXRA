/**
 * Catalog-driven settings controls.
 *
 * Every state-backed control in this view writes through the one
 * `UPDATE_STATE_SETTING` command keyed by a `stateSettings` catalog key, and
 * reads its allowed values from that same catalog. These helpers own both
 * halves so no tab re-derives "read the control, post the write" or re-derives
 * the enum option list from the catalog.
 */

// Local imports - shared webview
import { postMessage } from '@shared/hostBridge';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { StateSettingValue } from '@shared/schemas/settingsViewMessages';
import {
  settingEnumChoices,
  stateSettingByKey,
  type SettingEnumChoice,
} from '@shared/schemas/stateSettings';
import { renderSettingsToggleRow } from '@shared/wa/settingsSection';

// Third-party imports
import type { TemplateResult } from 'lit';

import type WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';

/**
 * The value shapes the `UPDATE_STATE_SETTING` boundary accepts — imported
 * from the wire schema so this cannot drift from what the backend validates
 * (the selected catalog entry's own schema performs the narrower per-key
 * validation backend-side).
 */

/** Write one catalog key. `null` clears it back to the catalog default. */
export function postStateSetting(key: string, value: StateSettingValue): void {
  postMessage(SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING, { key, value });
}

/**
 * Enum values for a catalog key, paired with the catalog's display metadata.
 * The allowed values come from the entry's `z.enum(...)` schema, so a settings
 * UI never hand-lists them. Non-enum or unknown keys yield an empty list.
 */
export function catalogEnumChoices<T extends string>(
  key: string,
): readonly SettingEnumChoice<T>[] {
  const entry = stateSettingByKey(key);
  return entry ? (settingEnumChoices<T>(entry) ?? []) : [];
}

interface StateSettingToggleRowOptions {
  /** Canonical `texra.*` catalog key this switch writes. */
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
}

/**
 * The shared switch row, bound to a catalog key: flipping it posts the write
 * itself, so a tab supplies only the key and the copy.
 */
export function renderStateSettingToggleRow(
  options: StateSettingToggleRowOptions,
): TemplateResult {
  return renderSettingsToggleRow({
    label: options.label,
    description: options.description,
    checked: options.checked,
    disabled: options.disabled,
    onChange: (event: Event) =>
      postStateSetting(
        options.key,
        Boolean((event.target as WaSwitch | null)?.checked),
      ),
  });
}
