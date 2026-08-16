/** Numeric reliability controls for long-running model sessions. */

import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';

// Local imports - shared webview
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import type { NumberSetting } from '@shared/schemas';
import {
  renderSettingsNumberRow,
  renderSettingsSectionHeading,
} from '@shared/wa/settingsSection';

@customElement('reliability-settings-section')
export class ReliabilitySettingsSection extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .setting-number-input {
        width: 80px;
      }

      .setting-unit {
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
      }
    `,
  ];

  @property({ attribute: false }) settings: NumberSetting[] = [];

  private renderSetting(setting: NumberSetting): TemplateResult {
    return renderSettingsNumberRow({
      label: setting.label,
      description: setting.description,
      value: setting.value,
      min: setting.min,
      max: setting.max,
      step: setting.step,
      unit: setting.unit,
      // Preserve this section's historical cleared-field behavior: an empty
      // input is `Number('')` (0), then the shared step/clamp math runs and
      // posts the resulting value rather than reverting.
      revertOnEmpty: false,
      onChange: (value) =>
        postMessage(SETTINGS_VIEW_COMMANDS.SET_PROVIDER_SETTING, {
          key: setting.key,
          value,
        }),
    });
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
