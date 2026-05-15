/** Numeric reliability controls for long-running model sessions. */

import '@awesome.me/webawesome/dist/components/input/input.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';

// Local imports - shared utilities
import { createEvent } from '@shared/utils/events';

// Local imports - shared schemas
import type { NumberVscodeSetting } from '@shared/schemas/settingsViewMessages';
import type WaInput from '@awesome.me/webawesome/dist/components/input/input.js';

function clampSetting(value: number, min?: number, max?: number): number {
  let result = value;
  if (min != null) result = Math.max(min, result);
  if (max != null) result = Math.min(max, result);
  return result;
}

@customElement('reliability-settings-section')
export class ReliabilitySettingsSection extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .setting-block {
        padding: var(--wa-space-xs);
        background-color: var(--wa-color-neutral-fill-quiet);
        border-radius: var(--border-radius);
      }

      .setting-description {
        margin: var(--wa-space-2xs) 0 var(--wa-space-xs) 0;
        font-size: var(--font-size-sm);
      }

      .setting-row {
        display: flex;
        align-items: center;
        gap: var(--wa-space-xs);
        padding: var(--wa-space-2xs) 0;
      }

      .setting-row label {
        min-width: 140px;
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-normal);
      }

      .setting-input {
        width: 80px;
      }

      .setting-unit {
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
      }

      .setting-help {
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
        margin: 0;
        padding-left: calc(140px + var(--wa-space-xs));
      }
    `,
  ];

  @property({ attribute: false }) settings: NumberVscodeSetting[] = [];

  private handleSettingChange(
    setting: NumberVscodeSetting,
    input: WaInput,
  ): void {
    const parsed = Number(input.value);
    if (Number.isNaN(parsed)) {
      input.value = String(setting.value);
      return;
    }
    const value = clampSetting(parsed, setting.min, setting.max);
    if (value !== parsed) input.value = String(value);
    this.dispatchEvent(
      createEvent('provider-vscode-setting-set', { key: setting.key, value }),
    );
  }

  private renderSetting(setting: NumberVscodeSetting): TemplateResult {
    return html`
      <div class="setting-row">
        <label>${setting.label}</label>
        <wa-input
          class="setting-input"
          type="number"
          .value=${String(setting.value)}
          min=${setting.min ?? nothing}
          max=${setting.max ?? nothing}
          @change=${(event: Event) =>
            this.handleSettingChange(setting, event.target as WaInput)}
        ></wa-input>
        ${setting.unit
          ? html`<span class="setting-unit">${setting.unit}</span>`
          : nothing}
      </div>
      <p class="setting-help">${setting.description}</p>
    `;
  }

  override render(): TemplateResult | typeof nothing {
    if (this.settings.length === 0) return nothing;
    return html`
      <h3>Reliability</h3>
      <p class="text-secondary setting-description">
        Tweak how long model sessions handle retries and context limits.
      </p>
      <div class="setting-block">
        ${this.settings.map((setting) => this.renderSetting(setting))}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'reliability-settings-section': ReliabilitySettingsSection;
  }
}
