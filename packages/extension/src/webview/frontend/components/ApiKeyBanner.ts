import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import {
  LitElement,
  html,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { designTokens, commonViewStyles } from '@shared/styles';
import type { ApiKeyBannerState } from '@shared/schemas';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { capitalize } from '@shared/utils/string';
import { applyBannerVisibility, bannerStyles } from '../styles/bannerStyles';
import { MainViewEvents } from '../events';

@customElement('api-key-banner')
export class ApiKeyBanner extends LitElement {
  static override styles = [designTokens, commonViewStyles, bannerStyles];

  @property({ attribute: false }) state: ApiKeyBannerState = {
    visible: false,
  };

  override updated(changed: PropertyValues<this>): void {
    if (changed.has('state')) {
      applyBannerVisibility(this, this.state.visible);
    }
  }

  private handleAction(action: 'set' | 'guide'): void {
    const provider = this.state.provider ?? '';
    this.dispatchEvent(MainViewEvents.apiKeyAction({ action, provider }));
  }

  override render(): TemplateResult {
    const provider = this.state.provider ?? '';
    const providerLabel = provider ? capitalize(provider) : '';

    return html`
      <div class="banner-frame">
        <wa-callout id="apiKeyBanner" variant="warning">
          ${waIcon('triangle-exclamation', { slot: 'icon' })}
          <div class="banner-row">
            <span>
              ${provider
                ? html`<strong>${providerLabel}</strong> API key missing.`
                : 'TeXRA requires an API key to run.'}
            </span>
            <div class="actions">
              <wa-button
                id="apiKeyBannerButton"
                appearance="plain"
                size="small"
                @click=${() => this.handleAction('set')}
              >
                ${waIcon('key', { slot: 'start' })}
                ${provider ? 'Set Key' : 'Set API Key'}
              </wa-button>
              <wa-button
                id="apiKeyGuideButton"
                appearance="plain"
                size="small"
                @click=${() => this.handleAction('guide')}
              >
                ${waIcon('book', { slot: 'start' })}
                ${provider ? 'Get Key' : 'API Key Guide'}
              </wa-button>
            </div>
            <span class="hint">
              Chat subscriptions (ChatGPT Plus, Claude Pro, etc.) do not include
              API access. You need a separate API key from the provider's
              developer platform.
            </span>
          </div>
        </wa-callout>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'api-key-banner': ApiKeyBanner;
  }
}
