/**
 * ApiAccessSection component - radio buttons to choose between included API access or personal keys.
 * Shows provider and model summary when using included access.
 */

// Third-party imports
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { badgeStyles, designTokens } from '@shared/styles';

// Local imports - profile view styles
import { profileViewStyles } from '../styles';

// Local imports - profile view events
import { ProfileViewEvents } from '../events';

@customElement('api-access-section')
export class ApiAccessSection extends LitElement {
  static override styles = [designTokens, ...badgeStyles, profileViewStyles];

  @property({ type: String }) mode: 'included' | 'personal' = 'personal';
  @property({ attribute: false }) enabledProviders: string[] = [];
  @property({ attribute: false }) allowedModels: string[] | null = [];

  private handleModeChange(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    const mode = target?.value === 'included' ? 'included' : 'personal';
    if (mode !== this.mode) {
      this.dispatchEvent(ProfileViewEvents.setApiAccessMode({ mode }));
    }
  }

  private renderModelSummary(): TemplateResult | typeof nothing {
    if (this.mode !== 'included') {
      return nothing;
    }

    const providerCount = this.enabledProviders.length;
    if (providerCount === 0) {
      return html`
        <div
          class="model-access-error"
          title="Try signing out and back in to refresh."
        >
          Unable to load model access. Try signing out and back in to refresh.
        </div>
      `;
    }

    const providerLabel = this.getProviderLabel(providerCount);
    const allowedModelsText = this.getAllowedModelsLabel();
    const allowedModelsList = this.renderAllowedModelsList();

    return html`
      <details class="model-access-info">
        <summary class="model-access-summary">
          <span>${providerLabel}</span>
          <span class="separator">·</span>
          <span>${allowedModelsText}</span>
        </summary>
        ${allowedModelsList}
      </details>
    `;
  }

  private getProviderLabel(providerCount: number): string {
    return `${providerCount} provider${providerCount === 1 ? '' : 's'}`;
  }

  private getAllowedModelsLabel(): string {
    if (this.allowedModels === null) {
      return 'all models';
    }
    if (this.allowedModels.length > 0) {
      return `${this.allowedModels.length} models`;
    }
    return 'none';
  }

  private renderAllowedModelsList(): TemplateResult | typeof nothing {
    if (!this.allowedModels || this.allowedModels.length === 0) {
      return nothing;
    }

    return html`
      <div class="models-list-container">
        ${this.allowedModels.map(
          (model) => html`<span class="badge badge--small">${model}</span>`,
        )}
      </div>
    `;
  }

  override render(): TemplateResult {
    return html`
      <div class="api-access-section">
        <h2>Model Access</h2>
        <p class="api-access-description">
          As a subscriber, you can use TeXRA's included model access or provide
          your own API keys.
        </p>
        <div class="api-access-options">
          <label class="api-access-option">
            <input
              type="radio"
              name="apiAccessMode"
              value="included"
              .checked=${this.mode === 'included'}
              @change=${this.handleModeChange}
            />
            <span class="option-content">
              <span class="option-title">Use Included Access</span>
              <span class="option-description"
                >Works automatically. No setup needed.</span
              >
            </span>
          </label>
          <label class="api-access-option">
            <input
              type="radio"
              name="apiAccessMode"
              value="personal"
              .checked=${this.mode === 'personal'}
              @change=${this.handleModeChange}
            />
            <span class="option-content">
              <span class="option-title">Use My Own Keys</span>
              <span class="option-description"
                >Provide your own API keys from OpenAI, Anthropic, etc.</span
              >
            </span>
          </label>
        </div>
        ${this.renderModelSummary()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'api-access-section': ApiAccessSection;
  }
}
