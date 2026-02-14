/**
 * Banner component for missing API key notification.
 *
 * Displays a warning banner when an API key is missing for a provider,
 * with actions to set or get the key.
 *
 * @fires api-key-action - When set/guide button is clicked
 */

// Third-party imports
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens, codiconStyles, commonViewStyles } from '@shared/styles';

// Local imports - shared banner styles
import { warningBannerStyles } from '../styles/warningBannerStyles';

// Local imports - main view events and schemas
import { MainViewEvents } from '../events';
import type { ApiKeyBannerState } from '@shared/schemas';

@customElement('api-key-banner')
export class ApiKeyBanner extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    commonViewStyles,
    warningBannerStyles,
  ];

  @property({ attribute: false }) state: ApiKeyBannerState = {
    visible: false,
  };

  private handleActionClick(event: MouseEvent): void {
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-action]',
    );
    const action = button?.dataset.action as 'set' | 'guide' | undefined;
    if (!action) return;
    const provider = this.state.provider ?? '';
    this.dispatchEvent(MainViewEvents.apiKeyAction({ action, provider }));
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.state.visible) return nothing;

    const provider = this.state.provider ?? '';
    const providerLabel = provider
      ? `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`
      : '';

    return html`
      <div id="apiKeyBanner" class="warning-banner">
        <span>
          ${provider
            ? html`<strong>${providerLabel}</strong> API key missing.`
            : 'TeXRA requires an API key to run.'}
        </span>
        <div class="actions" @click=${this.handleActionClick}>
          <vscode-toolbar-button
            id="apiKeyBannerButton"
            icon="key"
            data-action="set"
          >
            ${provider ? 'Set Key' : 'Set API Key'}
          </vscode-toolbar-button>
          <vscode-toolbar-button
            id="apiKeyGuideButton"
            icon="book"
            data-action="guide"
          >
            ${provider ? 'Get Key' : 'API Key Guide'}
          </vscode-toolbar-button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'api-key-banner': ApiKeyBanner;
  }
}
