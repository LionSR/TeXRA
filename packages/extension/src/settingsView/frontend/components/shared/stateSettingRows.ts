/**
 * Catalog-driven settings controls.
 *
 * Every state-backed control in this view writes through the one
 * `UPDATE_STATE_SETTING` command keyed by a `stateSettings` catalog key, and
 * reads its value from that key's setting signal and its copy and allowed
 * values from that same catalog. These helpers own both halves so no tab
 * passes a value down, re-derives "read the control, post the write" or
 * re-derives the enum option list from the catalog.
 */

// Local imports - shared webview
import { html, type TemplateResult } from 'lit';

import {
  settingSignal,
  settingsSnapshotRevisions,
} from '@settingsView/frontend/settingsState';
import type { SettingEnumChoice } from '@texra/shared/settingsView/settingRows';
import { settingEnumChoices } from '@texra/shared/settingsView/settingRows';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import { postMessage } from '@texra/shared/hostBridge';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import type { StateSettingValue } from '@texra/shared/settingsView/settingsViewMessages';
import { readSelectValue } from '@ui/wa/selectTemplates';
import {
  renderSettingsNumberRow,
  renderSettingsToggleRow,
  type SettingsNumberRowOptions,
} from '@ui/wa/settingsSection';

// Third-party imports
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';

import type WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';

/**
 * Write one catalog key. `null` clears it back to the catalog default.
 * `StateSettingValue` is the wire schema's own type, so the accepted value
 * shapes cannot drift from what the backend validates (the selected catalog
 * entry's schema performs the narrower per-key validation backend-side).
 */
export function postStateSetting(key: string, value: StateSettingValue): void {
  postMessage(SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING, { key, value });
}

/**
 * Enum values for a catalog key, paired with the catalog's display metadata.
 * The allowed values come from the entry's `Schema.Literals` schema, so a settings
 * UI never hand-lists them. Non-enum keys yield an empty list; a key with no
 * settings-view catalog row is a defect and throws, like
 * {@link renderStateSettingToggleRow}.
 */
export function catalogEnumChoices<T extends string>(
  key: string,
): readonly SettingEnumChoice<T>[] {
  const entry = TEXRA_SETTINGS.settingsViewByKey(key);
  if (!entry) {
    throw new Error(`No settings-view catalog row for setting "${key}"`);
  }
  return settingEnumChoices<T>(entry) ?? [];
}

/**
 * The catalog row a control renders, with the title every control labels it
 * with. A key with no settings-view row, or one with no title, is a defect.
 */
function titledRow(key: string) {
  const entry = TEXRA_SETTINGS.settingsViewByKey(key);
  if (!entry?.title) {
    throw new Error(
      `Settings-view catalog row "${key}" is missing or has no title`,
    );
  }
  return { ...entry, title: entry.title };
}

/**
 * The shared switch row, bound to a catalog key: the label and description are
 * the catalog row's own (the same copy every other host shows for that key),
 * the value is the key's setting signal, and flipping it posts the write
 * itself, so a tab supplies only the key. The calling component must be a
 * `SignalWatcher` so a new value repaints it.
 */
export function renderStateSettingToggleRow(
  key: string,
  options: { readonly disabled?: boolean } = {},
): TemplateResult {
  const entry = titledRow(key);
  return renderSettingsToggleRow({
    label: entry.title,
    description: entry.description,
    checked: settingSignal<boolean>(key).get(),
    disabled: options.disabled,
    onChange: (event: Event) =>
      postStateSetting(
        key,
        Boolean((event.target as WaSwitch | null)?.checked),
      ),
  });
}

/** A number row's own options. The label and help text default to the
 *  catalog row's; the value, write and acknowledgement are the key's. */
type StateSettingNumberRowOptions = Omit<
  SettingsNumberRowOptions,
  'label' | 'description' | 'value' | 'onChange' | 'ackGeneration'
> &
  Partial<Pick<SettingsNumberRowOptions, 'label' | 'description'>>;

/**
 * The number counterpart of {@link renderStateSettingToggleRow}. A committed
 * value posts the write, and the row repaints on every rebroadcast of its
 * catalog snapshot, so a rejected edit gives way to the saved value. Bounds,
 * step and unit stay the caller's, read from the setting's own constants.
 */
export function renderStateSettingNumberRow(
  key: string,
  options: StateSettingNumberRowOptions,
): TemplateResult {
  const entry = titledRow(key);
  return renderSettingsNumberRow({
    label: entry.title,
    description: entry.description,
    ...options,
    value: settingSignal<number | null>(key).get() ?? undefined,
    ackGeneration:
      settingsSnapshotRevisions.get()[entry.surfaces.settingsView] ?? 0,
    onChange: (value) => postStateSetting(key, value),
  });
}

/**
 * The select counterpart of {@link renderStateSettingToggleRow}: label, help
 * text, and options (with their per-value descriptions) all come from the
 * catalog row, and a change posts the write itself.
 */
export function renderStateSettingSelectRow(key: string): TemplateResult {
  const entry = titledRow(key);
  const id = `settings-select-${key.replaceAll('.', '-')}`;
  return html`
    <div class="settings-row">
      <div class="settings-row-text">
        <label class="settings-row-label" for=${id}>${entry.title}</label>
        <span class="settings-row-help">${entry.description}</span>
      </div>
      <div class="settings-row-control">
        <wa-select
          id=${id}
          .value=${settingSignal<string>(key).get()}
          @change=${(event: Event) => {
            const selected = readSelectValue(event);
            if (selected) postStateSetting(key, selected);
          }}
        >
          ${catalogEnumChoices(key).map(
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
