// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';

// Web Awesome switch (side-effect import — the toggle row renders one)
import '@awesome.me/webawesome/dist/components/switch/switch.js';

// Local imports - Web Awesome
import { waIcon } from './webAwesomeIcons';
import type { TeXRAIconName } from './iconNames';

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
function toggleRowId(label: string): string {
  return `settings-toggle-${label
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
  const id = toggleRowId(options.label);
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
