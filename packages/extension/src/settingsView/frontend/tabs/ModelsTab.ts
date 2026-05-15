/** API access, provider keys, and model selection for the settings view. */

import { LitElement, html, nothing, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';

// Web Awesome icon bundle (side-effect import)
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared schemas
import type {
  ModelSelectionItem,
  NumberVscodeSetting,
  ProviderKeyStatus,
} from '@shared/schemas/settingsViewMessages';

// Local imports - settings view components (side-effect: register)
import '../components/profile/ApiAccessSection';
import '../components/profile/ProviderKeyList';
import '../components/profile/ModelSelectionList';
import '../components/profile/ReliabilitySettingsSection';

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

  @property({ attribute: false }) authenticated = false;
  @property({ attribute: false }) apiAccessMode: 'included' | 'personal' =
    'personal';
  @property({ attribute: false }) allowedModels: string[] | null = [];
  @property({ attribute: false }) providerKeyStatuses: ProviderKeyStatus[] = [];
  @property({ attribute: false }) globalStreamingDefault = true;
  @property({ attribute: false }) modelSelectionItems: ModelSelectionItem[] =
    [];
  @property({ attribute: false }) reliabilitySettings: NumberVscodeSetting[] =
    [];
  @property({ attribute: false }) helperModel = '';
  @property({ type: Boolean }) preferShortModelNames = false;

  private scrollToSection(
    tagName: 'api-access-section' | 'provider-key-list',
  ): void {
    const el = this.shadowRoot?.querySelector(tagName);
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  private readonly handleScrollToApiAccess = (): void =>
    this.scrollToSection('api-access-section');

  private readonly handleScrollToApiConfig = (): void =>
    this.scrollToSection('provider-key-list');

  private renderTabHint(): TemplateResult {
    const description =
      this.apiAccessMode === 'included'
        ? 'Personal provider API keys are optional overrides—configure them in the API Configuration section below.'
        : 'To use your own keys for OpenAI, Anthropic, Google, and other providers, scroll to the API Configuration section below.';

    const accessJump = this.authenticated
      ? html`<button
          class="tab-action-btn"
          @click=${this.handleScrollToApiAccess}
        >
          Model Access
        </button>`
      : nothing;

    return html`
      <div class="settings-reminder">
        <wa-icon
          library="texra"
          name="info"
          class="settings-reminder-icon"
        ></wa-icon>
        <div class="settings-reminder-body">
          <div class="settings-reminder-title">API key settings</div>
          <div class="settings-reminder-description">${description}</div>
          <div class="settings-reminder-actions">
            ${accessJump}
            <button
              class="tab-action-btn"
              @click=${this.handleScrollToApiConfig}
            >
              <wa-icon library="texra" name="key"></wa-icon>
              Jump to API Configuration
            </button>
          </div>
        </div>
      </div>
    `;
  }

  override render(): TemplateResult {
    const apiAccessSection = this.authenticated
      ? html`<api-access-section
          .mode=${this.apiAccessMode}
        ></api-access-section>`
      : nothing;

    return html`
      <div class="models-container tab-content-container">
        ${this.renderTabHint()} ${apiAccessSection}
        <provider-key-list
          .providerKeyStatuses=${this.providerKeyStatuses}
          .apiAccessMode=${this.apiAccessMode}
          .globalStreamingDefault=${this.globalStreamingDefault}
        ></provider-key-list>
        <model-selection-list
          .models=${this.modelSelectionItems}
          .helperModel=${this.helperModel}
          .authenticated=${this.authenticated}
          .apiAccessMode=${this.apiAccessMode}
          .allowedModels=${this.allowedModels}
          .providerKeyStatuses=${this.providerKeyStatuses}
          .preferShortModelNames=${this.preferShortModelNames}
        ></model-selection-list>
        <reliability-settings-section
          .settings=${this.reliabilitySettings}
        ></reliability-settings-section>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'models-tab': ModelsTab;
  }
}
