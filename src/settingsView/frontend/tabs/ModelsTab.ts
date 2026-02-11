/**
 * ModelsTab component - API access, provider keys, and model selection for settings view.
 * Shows provider key list for all users; authenticated users also see API access mode.
 * Model selection list allows toggling which models appear in the dropdown.
 */

// Third-party imports
import { LitElement, html, nothing, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';

// Local imports - shared schemas
import type {
  ProviderKeyStatus,
  ModelSelectionItem,
} from '@shared/schemas/settingsViewMessages';

// Local imports - settings view components (side-effect: register)
import '../components/profile/ApiAccessSection';
import '../components/profile/ProviderKeyList';
import '../components/profile/ModelSelectionList';

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

  @property({ attribute: false }) authenticated = false;
  @property({ attribute: false }) apiAccessMode: 'included' | 'personal' =
    'personal';
  @property({ attribute: false }) allowedModels: string[] | null = [];
  @property({ attribute: false }) providerKeyStatuses: ProviderKeyStatus[] = [];
  @property({ attribute: false }) globalStreamingDefault = true;
  @property({ attribute: false }) modelSelectionItems: ModelSelectionItem[] =
    [];
  @property({ attribute: false }) polishModel = '';

  override render(): TemplateResult {
    const apiAccessSection = this.authenticated
      ? html`<api-access-section
          .mode=${this.apiAccessMode}
        ></api-access-section>`
      : nothing;

    return html`
      <div class="models-container">
        ${apiAccessSection}
        <model-selection-list
          .models=${this.modelSelectionItems}
          .polishModel=${this.polishModel}
          .authenticated=${this.authenticated}
          .apiAccessMode=${this.apiAccessMode}
          .allowedModels=${this.allowedModels}
        ></model-selection-list>
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
