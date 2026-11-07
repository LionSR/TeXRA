/**
 * Catalog-driven settings controls.
 *
 * Every state-backed control in this view writes through the one
 * `UPDATE_STATE_SETTING` command keyed by a catalog row's key, and reads its
 * value from that row's setting signal and its copy, bounds and allowed
 * values from that same row. These helpers own both halves so no tab
 * passes a value down, re-derives "read the control, post the write" or
 * re-derives the enum option list from the catalog.
 */

// Local imports - shared webview
import WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';
import { html, type TemplateResult } from 'lit';

import {
  settingSignal,
  settingsSnapshotRevisions,
} from '@settingsView/frontend/settingsState';
import type { SettingEnumChoice } from '@texra/shared/settingsView/settingRows';
import {
  settingEnumChoices,
  settingNumberBounds,
} from '@texra/shared/settingsView/settingRows';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import { postMessage } from '@texra/shared/hostBridge';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import type { StateSettingValue } from '@texra/shared/settingsView/settingsViewMessages';
import type { SettingRow } from '@texra-ai/harness/schemas';
import { readSelectValue } from '@ui/wa/selectTemplates';
import {
  renderSettingsNumberRow,
  renderSettingsToggleRow,
  type SettingsNumberRowOptions,
} from '@ui/wa/settingsSection';

// Third-party imports
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';

/**
 * Write one catalog row by its wire key. `null` clears it back to the catalog
 * default. `StateSettingValue` is the wire schema's own type, so the accepted
 * value shapes cannot drift from what the backend validates (the row's
 * schema performs the narrower per-row validation backend-side).
 */
export function postStateSetting(key: string, value: StateSettingValue): void {
  postMessage(SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING, { key, value });
}

/**
 * Enum values for a catalog row, paired with the catalog's display metadata.
 * The allowed values come from the row's `Schema.Literals` schema, so a
 * settings UI never hand-lists them. Non-enum rows yield an empty list; a row
 * with no settings-view placement is a defect and throws, like
 * {@link renderStateSettingToggleRow}.
 */
export function catalogEnumChoices(
  row: SettingRow,
): readonly SettingEnumChoice[] {
  return settingEnumChoices(placedRow(row)) ?? [];
}

/**
 * The placed row a control renders, as the catalog holds it. A row with no
 * settings-view placement is a defect: no snapshot would ever reach it.
 */
function placedRow(row: SettingRow) {
  const entry = TEXRA_SETTINGS.settingsViewByKey(row.key);
  if (!entry) {
    throw new Error(`No settings-view catalog row for setting "${row.key}"`);
  }
  return entry;
}

/**
 * The shared switch row, bound to a catalog row: the label and description
 * are the row's own (the same copy every other host shows for it), the value
 * is the row's setting signal, and flipping it posts the write itself, so a
 * tab supplies only the row. The calling component must be a `SignalWatcher`
 * so a new value repaints it.
 */
export function renderStateSettingToggleRow(
  row: SettingRow<boolean>,
  options: { readonly disabled?: boolean } = {},
): TemplateResult {
  const entry = placedRow(row);
  return renderSettingsToggleRow({
    label: entry.title,
    description: entry.description,
    checked: settingSignal(row).get(),
    disabled: options.disabled,
    onChange: (event: Event) =>
      postStateSetting(
        row.key,
        event.target instanceof WaSwitch && event.target.checked,
      ),
  });
}

/** A number row's own options. The label and help text default to the
 *  catalog row's; the bounds, value, write and acknowledgement are the
 *  row's. */
type StateSettingNumberRowOptions = Omit<
  SettingsNumberRowOptions,
  | 'label'
  | 'description'
  | 'value'
  | 'onChange'
  | 'ackGeneration'
  | 'min'
  | 'max'
> &
  Partial<Pick<SettingsNumberRowOptions, 'label' | 'description'>>;

/**
 * The number counterpart of {@link renderStateSettingToggleRow}. A committed
 * value posts the write, and the row repaints on every rebroadcast of its
 * catalog snapshot, so a rejected edit gives way to the saved value. The
 * bounds are the row schema's; step and unit stay the caller's.
 */
export function renderStateSettingNumberRow(
  row: SettingRow<number | null>,
  options: StateSettingNumberRowOptions = {},
): TemplateResult {
  const entry = placedRow(row);
  return renderSettingsNumberRow({
    label: entry.title,
    description: entry.description,
    ...settingNumberBounds(row),
    ...options,
    value: settingSignal(row).get() ?? undefined,
    ackGeneration:
      settingsSnapshotRevisions.get()[entry.surfaces.settingsView] ?? 0,
    onChange: (value) => postStateSetting(row.key, value),
  });
}

/**
 * The select counterpart of {@link renderStateSettingToggleRow}: label, help
 * text, and options (with their per-value descriptions) all come from the
 * catalog row, and a change posts the write itself.
 */
export function renderStateSettingSelectRow(
  row: SettingRow<string>,
): TemplateResult {
  const entry = placedRow(row);
  const id = `settings-select-${row.key.replaceAll('.', '-')}`;
  return html`
    <div class="settings-row">
      <div class="settings-row-text">
        <label class="settings-row-label" for=${id}>${entry.title}</label>
        <span class="settings-row-help">${entry.description}</span>
      </div>
      <div class="settings-row-control">
        <wa-select
          id=${id}
          .value=${settingSignal(row).get()}
          @change=${(event: Event) => {
            const selected = readSelectValue(event);
            if (selected) postStateSetting(row.key, selected);
          }}
        >
          ${catalogEnumChoices(row).map(
            (choice) => html`
              <wa-option value=${choice.value}
                >${
                  choice.description
                    ? `${choice.label} — ${choice.description}`
                    : choice.label
                }</wa-option
              >
            `,
          )}
        </wa-select>
      </div>
    </div>
  `;
}
