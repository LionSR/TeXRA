/** Privacy and telemetry: the top of the General page. */

// Third-party imports
import { css, html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Local imports - shared webview
import { TELEMETRY_ENABLED_SETTING } from '@texra/shared/settings/texraSettings';
import { renderSettingsSectionHeading } from '@ui/wa/settingsSection';
import { TexraSignalElement } from '@ui/litBase';

// Local imports - catalog-driven settings rows
import { renderStateSettingToggleRow } from '../components/shared/stateSettingRows';

@customElement('privacy-tab')
export class PrivacyTab extends TexraSignalElement {
  static override styles = [
    TexraSignalElement.styles,
    css`
      :host {
        display: block;
      }
    `,
  ];

  override render(): TemplateResult {
    return html`
      <div class="tab-content-container">
        <section>
          ${renderSettingsSectionHeading({
            title: 'Privacy',
            icon: 'shield',
          })}
          <div class="settings-section">
            ${renderStateSettingToggleRow(TELEMETRY_ENABLED_SETTING)}
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
