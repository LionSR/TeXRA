// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens, commonViewStyles, codiconStyles } from '@shared/styles';

// Local imports - main view
import { bannerStyles } from '@webview/frontend/styles';

export type ApiKeyBannerAction = 'set' | 'guide';

export interface ApiKeyBannerActionDetail {
  action: ApiKeyBannerAction;
}

@customElement('api-key-banner')
export class ApiKeyBanner extends LitElement {
  static styles = [designTokens, commonViewStyles, codiconStyles, bannerStyles];

  @property({ type: Boolean }) visible = false;
  @property({ type: String }) provider = '';
  @property({ type: Boolean }) requiresKey = false;

  private emitAction(action: ApiKeyBannerAction): void {
    this.dispatchEvent(
      new CustomEvent<ApiKeyBannerActionDetail>('api-key-banner-action', {
        detail: { action },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleActionClick = (event: Event): void => {
    const target = event.currentTarget as HTMLElement | null;
    const action = target?.dataset.action as ApiKeyBannerAction | undefined;
    if (!action) return;
    this.emitAction(action);
  };

  render(): TemplateResult {
    const providerLabel = this.provider
      ? `${this.provider.charAt(0).toUpperCase()}${this.provider.slice(1)}`
      : '';
    return html`
      <div
        id="apiKeyBanner"
        class="api-key-banner"
        style=${this.visible ? 'display: flex' : 'display: none'}
      >
        <span>
          ${this.provider
            ? html`<strong>${providerLabel}</strong> API key missing.`
            : 'TeXRA requires an API key to run.'}
        </span>
        <div class="actions">
          <vscode-toolbar-button
            id="apiKeyBannerButton"
            icon="key"
            data-action="set"
            @click=${this.handleActionClick}
          >
            ${this.provider ? 'Set Key' : 'Set API Key'}
          </vscode-toolbar-button>
          <vscode-toolbar-button
            id="apiKeyGuideButton"
            icon="book"
            data-action="guide"
            @click=${this.handleActionClick}
          >
            ${this.provider ? 'Get Key' : 'API Key Guide'}
          </vscode-toolbar-button>
        </div>
      </div>
    `;
  }
}
