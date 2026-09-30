/** Privacy and telemetry: the top of the General page. */

// Third-party imports
import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared webview
import { TELEMETRY_ENABLED_KEY } from '@shared/schemas';
import { commonViewStyles, designTokens } from '@ui/styles';
import { renderSettingsSectionHeading } from '@ui/wa/settingsSection';

// Local imports - catalog-driven settings rows
import { renderStateSettingToggleRow } from '../components/shared/stateSettingRows';

@customElement('privacy-tab')
export class PrivacyTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }
    `,
  ];

  @property({ type: Boolean }) telemetryEnabled = true;

  override render(): TemplateResult {
    return html`
      <div class="tab-content-container">
        <section>
          ${renderSettingsSectionHeading({
            title: 'Privacy',
            description:
              'Choose whether TeXRA sends anonymous usage metadata (model, agent, token counts, timing) with a random install ID. No prompts, paths or document text.',
            icon: 'shield',
          })}
          <div class="settings-section">
            ${renderStateSettingToggleRow({
              key: TELEMETRY_ENABLED_KEY,
              checked: this.telemetryEnabled,
            })}
          </div>
        </section>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'privacy-tab': PrivacyTab;
  }
}
