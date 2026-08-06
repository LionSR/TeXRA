import '@awesome.me/webawesome/dist/components/button/button.js';
import { html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { designTokens, commonViewStyles, bannerStyles } from '@shared/styles';
import type { ApiKeyBannerState } from '@shared/schemas';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { renderWarningBanner } from '@shared/wa/bannerFrame';
import { capitalize } from '@utils/text/stringUtils';
import { StateVisibleBanner } from './StateVisibleBanner';
import { MainViewEvents } from '../events';

@customElement('api-key-banner')
export class ApiKeyBanner extends StateVisibleBanner<ApiKeyBannerState> {
  static override styles = [designTokens, commonViewStyles, bannerStyles];

  @property({ attribute: false }) state: ApiKeyBannerState = {
    visible: false,
  };

  private handleAction(action: 'set' | 'guide'): void {
    const provider = this.state.provider ?? '';
    this.dispatchEvent(MainViewEvents.apiKeyAction({ action, provider }));
  }

  override render(): TemplateResult {
    const provider = this.state.provider ?? '';
    const providerLabel = provider ? capitalize(provider) : '';

    return renderWarningBanner({
      id: 'apiKeyBanner',
      role: 'alert',
      body: html`
        <span>
          ${
            provider
              ? html`<strong>${providerLabel}</strong> API key missing.`
              : 'TeXRA requires an API key to run.'
          }
        </span>
        <div class="actions">
          <wa-button
            id="apiKeyBannerButton"
            appearance="plain"
            size="s"
            @click=${() => this.handleAction('set')}
          >
            ${waIcon('key', { slot: 'start' })}
            ${provider ? 'Set Key' : 'Set API Key'}
          </wa-button>
          <wa-button
            id="apiKeyGuideButton"
            appearance="plain"
            size="s"
            @click=${() => this.handleAction('guide')}
          >
            ${waIcon('book', { slot: 'start' })}
            ${provider ? 'Get Key' : 'API Key Guide'}
          </wa-button>
        </div>
        <span class="hint">
          Chat subscriptions don't include API access - except Codex models
          through ChatGPT. For other models, use a provider developer key.
        </span>
      `,
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'api-key-banner': ApiKeyBanner;
  }
}
