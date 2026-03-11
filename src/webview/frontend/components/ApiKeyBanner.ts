import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { designTokens, codiconStyles, commonViewStyles } from '@shared/styles';
import type { ApiKeyBannerState } from '@shared/schemas';
import { capitalize } from '@shared/utils/string';
import { warningBannerStyles } from '../styles/warningBannerStyles';
import { MainViewEvents } from '../events';

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
    const providerLabel = provider ? capitalize(provider) : '';

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
        <span class="hint">
          Chat subscriptions (ChatGPT Plus, Claude Pro, etc.) do not include API
          access. You need a separate API key from the provider's developer
          platform.
        </span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'api-key-banner': ApiKeyBanner;
  }
}
