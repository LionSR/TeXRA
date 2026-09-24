/**
 * The Models page: connect a model (API keys, then subscriptions), then choose
 * which models appear.
 */

import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import type { SubscriptionUsageSnapshots } from '@shared/schemas';
import type {
  ModelSelectionItem,
  ProviderKeyStatus,
} from '@shared/settingsView/settingsViewMessages';
import { commonViewStyles, designTokens } from '@ui/styles';

// Local imports - settings view components (side-effect: register)
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

      /* max-width and centering provided by .tab-content-container */
    `,
  ];

  @property({ attribute: false }) providerKeyStatuses: ProviderKeyStatus[] = [];
  @property({ attribute: false }) modelSelectionItems: ModelSelectionItem[] =
    [];
  @property({ attribute: false }) helperModel = '';
  @property({ type: Boolean }) preferShortModelNames = false;
  @property({ attribute: false }) usage: SubscriptionUsageSnapshots | null =
    null;

  override render(): TemplateResult {
    return html`
      <div class="models-container tab-content-container">
        <provider-key-list
          .providerKeyStatuses=${this.providerKeyStatuses}
          .usage=${this.usage}
        ></provider-key-list>
        <slot name="subscriptions"></slot>
        <model-selection-list
          .models=${this.modelSelectionItems}
          .helperModel=${this.helperModel}
          .providerKeyStatuses=${this.providerKeyStatuses}
          .preferShortModelNames=${this.preferShortModelNames}
        ></model-selection-list>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'models-tab': ModelsTab;
  }
}
