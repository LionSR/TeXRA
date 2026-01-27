// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { badgeStyles, designTokens } from '@shared/styles';

// Local imports - profile view styles
import { profileViewStyles } from '../styles';

// Local imports - profile view events
import { ProfileViewEvents } from '../events';

@customElement('api-access-section')
export class ApiAccessSection extends LitElement {
  static styles = [designTokens, ...badgeStyles, profileViewStyles];

  @property({ type: String }) mode: 'included' | 'personal' = 'personal';
  @property({ attribute: false }) enabledProviders: string[] = [];
  @property({ attribute: false }) allowedModels: string[] | null = [];

  private handleModeChange = (event: Event): void => {
    const target = event.target as HTMLInputElement | null;
    const value = target?.value === 'included' ? 'included' : 'personal';
    if (value !== this.mode) {
      this.dispatchEvent(ProfileViewEvents.setApiAccessMode({ mode: value }));
    }
  };

  private renderModelSummary(): TemplateResult {
    if (this.mode !== 'included') {
      return html``;
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

    const providerLabel = `${providerCount} provider${
      providerCount !== 1 ? 's' : ''
    }`;

    let allowedModelsText = 'none';
    if (this.allowedModels === null) {
      allowedModelsText = 'all models';
    } else if (this.allowedModels.length > 0) {
      allowedModelsText = `${this.allowedModels.length} models`;
    }

    return html`
      <details class="model-access-info">
        <summary class="model-access-summary">
          <span>${providerLabel}</span>
          <span class="separator">·</span>
          <span>${allowedModelsText}</span>
        </summary>
        ${this.allowedModels && this.allowedModels.length > 0
          ? html`
              <div class="models-list-container">
                ${this.allowedModels.map(
                  (model) =>
                    html`<span class="badge badge--small">${model}</span>`,
                )}
              </div>
            `
          : ''}
      </details>
    `;
  }

  render(): TemplateResult {
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
