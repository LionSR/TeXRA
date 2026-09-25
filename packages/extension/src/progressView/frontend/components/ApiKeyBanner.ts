import '@awesome.me/webawesome/dist/components/button/button.js';
import { html, LitElement, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

import { SessionUiEvents } from '@shared/session/uiEvents';
import { designTokens, commonViewStyles, bannerStyles } from '@ui/styles';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { renderWarningBanner } from '@ui/wa/bannerFrame';

@customElement('api-key-banner')
export class ApiKeyBanner extends LitElement {
  static override styles = [designTokens, commonViewStyles, bannerStyles];

  private handleAction(action: 'set' | 'guide'): void {
    this.dispatchEvent(SessionUiEvents.host({ kind: 'apiKeyBanner', action }));
  }

  override render(): TemplateResult {
    return renderWarningBanner({
      id: 'apiKeyBanner',
      role: 'alert',
      body: html`
        <span>TeXRA requires an API key to run.</span>
        <div class="actions">
          <wa-button
            id="apiKeyBannerButton"
            appearance="plain"
            size="s"
            @click=${() => this.handleAction('set')}
          >
            ${waIcon('key', { slot: 'start' })} Set API key
          </wa-button>
          <wa-button
            id="apiKeyGuideButton"
            appearance="plain"
            size="s"
            @click=${() => this.handleAction('guide')}
          >
            ${waIcon('book', { slot: 'start' })} Open key guide
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
