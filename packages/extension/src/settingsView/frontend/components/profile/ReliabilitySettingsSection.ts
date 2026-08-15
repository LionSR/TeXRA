/** Numeric reliability controls for long-running model sessions. */

import '@awesome.me/webawesome/dist/components/input/input.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';

// Local imports - shared webview
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import type { NumberSetting } from '@shared/schemas';
import { renderSettingsSectionHeading } from '@shared/wa/settingsSection';
import { clampOptional } from '@utils/core';

// Local imports - shared schemas
import type WaInput from '@awesome.me/webawesome/dist/components/input/input.js';

@customElement('reliability-settings-section')
export class ReliabilitySettingsSection extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .setting-input {
        width: 80px;
      }

      .setting-unit {
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
      }
    `,
  ];

  @property({ attribute: false }) settings: NumberSetting[] = [];

  private handleSettingChange(setting: NumberSetting, input: WaInput): void {
    const parsed = Number(input.value);
    if (Number.isNaN(parsed)) {
      input.value = String(setting.value);
      return;
    }
    const stepOrigin = setting.min ?? 0;
    const stepped =
      setting.step === undefined
        ? parsed
        : stepOrigin +
          Math.round((parsed - stepOrigin) / setting.step) * setting.step;
    const value = clampOptional(stepped, setting.min, setting.max);
    if (value !== parsed) input.value = String(value);
    postMessage(SETTINGS_VIEW_COMMANDS.SET_PROVIDER_SETTING, {
      key: setting.key,
      value,
    });
  }

  private renderSetting(setting: NumberSetting): TemplateResult {
    // Real `<label for>` + host id: an aria-label on the wa-input host names
    // the custom element, not the inner number control (see
    // settingsSection.ts). `setting.key` is unique within this section.
    const controlId = `reliability-setting-${setting.key}`;
    return html`
      <div class="settings-row">
        <div class="settings-row-text">
          <label class="settings-row-label" for=${controlId}
            >${setting.label}</label
          >
          <span class="settings-row-help">${setting.description}</span>
        </div>
        <div class="settings-row-control">
          <wa-input
            id=${controlId}
            class="setting-input"
            type="number"
            .value=${String(setting.value)}
            min=${setting.min ?? nothing}
            max=${setting.max ?? nothing}
            step=${setting.step ?? nothing}
            @change=${(event: Event) =>
              this.handleSettingChange(setting, event.target as WaInput)}
          ></wa-input>
          ${
            setting.unit
              ? html`<span class="setting-unit">${setting.unit}</span>`
              : nothing
          }
        </div>
      </div>
    `;
  }

  override render(): TemplateResult | typeof nothing {
    if (this.settings.length === 0) return nothing;
    return html`
      ${renderSettingsSectionHeading({
        title: 'Reliability',
        description:
          'Tweak how long model sessions handle retries and context limits.',
        icon: 'rotate-right',
      })}
      <div class="settings-section">
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
