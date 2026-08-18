// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { live } from 'lit/directives/live.js';

// Web Awesome switch + input (side-effect imports — the rows render them)
import '@awesome.me/webawesome/dist/components/switch/switch.js';
import '@awesome.me/webawesome/dist/components/input/input.js';

// Local imports - utils
import { clampOptional } from '@utils/core';

// Local imports - Web Awesome
import { waIcon } from './webAwesomeIcons';
import type { TeXRAIconName } from './iconNames';

// Web Awesome input element type (kept after local imports per import/order)
import type WaInput from '@awesome.me/webawesome/dist/components/input/input.js';

export interface SettingsSectionHeadingOptions {
  readonly title: string;
  readonly description?: string | TemplateResult;
  readonly icon?: TeXRAIconName;
  readonly actions?: TemplateResult | typeof nothing;
  readonly id?: string;
}

/** Renders the one heading hierarchy shared by every Settings page section. */
export function renderSettingsSectionHeading(
  options: SettingsSectionHeadingOptions,
): TemplateResult {
  return html`
    <header class="settings-section-heading">
      <div class="settings-section-heading-row">
        ${
          options.icon
            ? waIcon(options.icon, {
                className: 'settings-section-heading-icon',
              })
            : nothing
        }
        <h2 id=${options.id ?? nothing} class="settings-section-heading-title">
          ${options.title}
        </h2>
        ${
          options.actions
            ? html`<div class="settings-section-heading-actions">
                ${options.actions}
              </div>`
            : nothing
        }
      </div>
      ${
        options.description
          ? html`<p class="settings-section-heading-description">
              ${options.description}
            </p>`
          : nothing
      }
    </header>
  `;
}

export interface SettingsToggleRowOptions {
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (event: Event) => void;
}

/** Stable per-row id derived from the label, so the `for`/`id` pair does not
 *  churn across re-renders the way a counter would. Labels are unique within a
 *  settings page. */
function settingsRowId(kind: 'toggle' | 'number', label: string): string {
  return `settings-${kind}-${label
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')}`;
}

/**
 * The one switch row shared by every Settings page: label/help on the left,
 * the switch in the control slot. A switch is its own state indicator — do
 * not add status icons beside it.
 *
 * The visible label is a real `<label for>`, not a `<span>` plus an
 * `aria-label` on the host. WebAwesome renders
 * `<label part="base"><input role="switch"> … </label>` inside its shadow root,
 * so a host `aria-label` names the custom element rather than the control that
 * carries the role — all 21 rows built by this helper were reaching the
 * accessibility tree unnamed. `wa-switch` is a form-associated custom element
 * (`WebAwesomeFormAssociatedElement.formAssociated = true`), which makes it
 * labelable, so a light-DOM `for` associates properly.
 *
 * It also means the label text is now part of the switch's hit target, which
 * is what removes the dead zone between a toggle and the words describing it.
 */
export function renderSettingsToggleRow(
  options: SettingsToggleRowOptions,
): TemplateResult {
  const id = settingsRowId('toggle', options.label);
  return html`
    <div class="settings-row">
      <div class="settings-row-text">
        <label class="settings-row-label" for=${id}>${options.label}</label>
        <span class="settings-row-help">${options.description}</span>
      </div>
      <div class="settings-row-control">
        <wa-switch
          id=${id}
          ?checked=${options.checked}
          ?disabled=${options.disabled}
          @change=${options.onChange}
        ></wa-switch>
      </div>
    </div>
  `;
}

export interface SettingsNumberRowOptions {
  readonly label: string;
  readonly description: string;
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly disabled?: boolean;
  /** Optional unit text rendered beside the input. */
  readonly unit?: string;
  /**
   * What a cleared field means. Defaults to `true` (revert to the last
   * committed value). Pass `false` for the provider reliability section's
   * legacy behavior: `Number('')` is 0, then the normal step/clamp math runs
   * and posts that value.
   */
  readonly revertOnEmpty?: boolean;
  readonly onChange: (value: number) => void;
}

/**
 * Shared numeric settings row used by the catalog-bound rows and the provider
 * reliability section. Cleared input reverts to the last committed value by
 * default; `revertOnEmpty: false` opts into the legacy commit-zero/min path.
 * `onChange` receives the parsed, stepped, and clamped value. The visible label
 * is a real `<label for>` (see the toggle row for the accessibility rationale).
 */
export function renderSettingsNumberRow(
  options: SettingsNumberRowOptions,
): TemplateResult {
  const id = settingsRowId('number', options.label);

  const commit = (input: WaInput, raw: string): void => {
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
      input.value = String(options.value);
      return;
    }
    const stepOrigin = options.min ?? 0;
    const stepped =
      options.step === undefined
        ? parsed
        : stepOrigin +
          Math.round((parsed - stepOrigin) / options.step) * options.step;
    const value = clampOptional(stepped, options.min, options.max);
    if (value !== parsed) input.value = String(value);
    options.onChange(value);
  };

  const handleChange = (event: Event): void => {
    const input = event.target as WaInput;
    const raw = input.value;
    if (typeof raw !== 'string' || raw.trim() === '') {
      if (options.revertOnEmpty === false) {
        commit(input, '0');
        return;
      }
      // Treat a cleared field as "no change" — `Number('')` would silently
      // coerce to 0/min and overwrite the saved value.
      input.value = String(options.value);
      return;
    }
    commit(input, raw);
  };

  return html`
    <div class="settings-row">
      <div class="settings-row-text">
        <label class="settings-row-label" for=${id}>${options.label}</label>
        <span class="settings-row-help">${options.description}</span>
      </div>
      <div class="settings-row-control">
        <wa-input
          id=${id}
          class="setting-number-input"
          type="number"
          .value=${live(String(options.value))}
          min=${options.min ?? nothing}
          max=${options.max ?? nothing}
          step=${options.step ?? nothing}
          ?disabled=${options.disabled}
          @change=${handleChange}
        ></wa-input>
        ${
          options.unit
            ? html`<span class="setting-unit">${options.unit}</span>`
            : nothing
        }
      </div>
    </div>
  `;
}
