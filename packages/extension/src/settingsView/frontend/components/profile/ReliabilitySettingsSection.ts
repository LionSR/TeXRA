/** Numeric reliability controls for long-running model sessions. */

import '@awesome.me/webawesome/dist/components/input/input.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';

// Local imports - shared webview
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import type { NumberVscodeSetting } from '@shared/schemas/settingsViewMessages';
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

      .setting-description {
        margin: var(--wa-space-2xs) 0 var(--wa-space-xs) 0;
        font-size: var(--font-size-sm);
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
    const value = clampOptional(parsed, setting.min, setting.max);
    if (value !== parsed) input.value = String(value);
    postMessage(SETTINGS_VIEW_COMMANDS.SET_PROVIDER_VSCODE_SETTING, {
      key: setting.key,
      value,
    });
  }

  private renderSetting(setting: NumberVscodeSetting): TemplateResult {
    return html`
      <div class="settings-row">
        <div class="settings-row-text">
          <span class="settings-row-label">${setting.label}</span>
          <span class="settings-row-help">${setting.description}</span>
        </div>
        <div class="settings-row-control">
          <wa-input
            class="setting-input"
            type="number"
            aria-label=${setting.label}
            .value=${String(setting.value)}
            min=${setting.min ?? nothing}
            max=${setting.max ?? nothing}
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
      <h3>Reliability</h3>
      <p class="text-secondary setting-description">
        Tweak how long model sessions handle retries and context limits.
      </p>
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
