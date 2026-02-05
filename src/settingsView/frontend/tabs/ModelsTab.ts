/**
 * ModelsTab component - API access and model settings for settings view.
 * Shows provider key list for all users; authenticated users also see API access mode.
 */

// Third-party imports
import { LitElement, html, nothing, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';

// Local imports - shared schemas
import type { ProviderKeyStatus } from '@shared/schemas/settingsViewMessages';

// Local imports - settings view components (side-effect: register)
import '../components/profile/ApiAccessSection';
import '../components/profile/ProviderKeyList';

@customElement('models-tab')
export class ModelsTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .models-container {
        max-width: 1000px;
        margin: 0 auto;
      }
    `,
  ];

  @property({ type: Boolean }) authenticated = false;
  @property({ type: String }) apiAccessMode: 'included' | 'personal' =
    'personal';
  @property({ attribute: false }) enabledProviders: string[] = [];
  @property({ attribute: false }) allowedModels: string[] | null = [];
  @property({ attribute: false }) providerKeyStatuses: ProviderKeyStatus[] = [];
  @property({ type: Boolean }) globalStreamingDefault = true;

  override render(): TemplateResult {
    const apiAccessSection = this.authenticated
      ? html`<api-access-section
          .mode=${this.apiAccessMode}
          .enabledProviders=${this.enabledProviders}
          .allowedModels=${this.allowedModels}
        ></api-access-section>`
      : nothing;

    return html`
      <div class="models-container">
        ${apiAccessSection}
        <provider-key-list
          .providerKeyStatuses=${this.providerKeyStatuses}
          .apiAccessMode=${this.apiAccessMode}
          .globalStreamingDefault=${this.globalStreamingDefault}
        ></provider-key-list>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'models-tab': ModelsTab;
  }
}
