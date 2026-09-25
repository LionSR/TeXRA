import '@awesome.me/webawesome/dist/components/button/button.js';
import { html, LitElement, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { HostSnapshot } from '@shared/session/hostSnapshot';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { designTokens, commonViewStyles, bannerStyles } from '@ui/styles';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { renderWarningBanner } from '@ui/wa/bannerFrame';
import { capitalize } from '@utils/text/stringUtils';

@customElement('api-key-banner')
export class ApiKeyBanner extends LitElement {
  static override styles = [designTokens, commonViewStyles, bannerStyles];

  @property({ attribute: false }) state: HostSnapshot['banners']['apiKey'] = {
    visible: false,
  };

  private handleAction(action: 'set' | 'guide'): void {
    this.dispatchEvent(
      SessionUiEvents.host({
        kind: 'apiKeyBanner',
        action,
        provider: this.state.provider,
      }),
    );
  }

  override render(): TemplateResult {
    const provider = this.state.provider ?? '';
    const providerLabel = capitalize(provider);

    return renderWarningBanner({
      id: 'apiKeyBanner',
      role: 'alert',
      body: html`
        <span>
          ${
            provider
              ? html`<strong><bdi dir="auto">${providerLabel}</bdi></strong> API
                  key is missing.`
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
            ${
              provider
                ? html`Set <bdi dir="auto">${providerLabel}</bdi> API key`
                : 'Set API key'
            }
          </wa-button>
          <wa-button
            id="apiKeyGuideButton"
            appearance="plain"
            size="s"
            @click=${() => this.handleAction('guide')}
          >
            ${waIcon('book', { slot: 'start' })}
            ${
              provider
                ? html`Get <bdi dir="auto">${providerLabel}</bdi> API key`
                : 'Open key guide'
            }
          </wa-button>
        </div>
        <span class="hint">
          Chat subscriptions don't include API access — except Codex models
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
