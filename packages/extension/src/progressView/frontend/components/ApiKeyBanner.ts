import '@awesome.me/webawesome/dist/components/button/button.js';
import { html, LitElement, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

import { SessionUiEvents } from '@shared/session/uiEvents';
import { designTokens, commonViewStyles, bannerStyles } from '@ui/styles';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { renderWarningBanner } from '@ui/wa/bannerFrame';
import {
  CREDENTIAL_LOST_NOTICE,
  ONBOARDING_CHOICE_CHATGPT,
} from '@ui/copy/onboarding';

/**
 * The credential-lost banner: shown only once a credential that worked stops
 * working (the host raises it after a first task has finished). Until then
 * the "Connect a model" card is the one prompt, so the banner never repeats
 * it on a first install.
 */
@customElement('api-key-banner')
export class ApiKeyBanner extends LitElement {
  static override styles = [designTokens, commonViewStyles, bannerStyles];

  private handleAction(action: 'set' | 'guide'): void {
    this.dispatchEvent(SessionUiEvents.host({ kind: 'apiKeyBanner', action }));
  }

  /** The same host action as the card's first choice, so reconnecting
   *  offers both ways to connect, not only one. */
  private signInChatGpt(): void {
    this.dispatchEvent(
      SessionUiEvents.host({ kind: 'onboarding', action: 'signInChatGpt' }),
    );
  }

  override render(): TemplateResult {
    return renderWarningBanner({
      id: 'apiKeyBanner',
      role: 'alert',
      body: html`
        <span>${CREDENTIAL_LOST_NOTICE}</span>
        <div class="actions">
          <wa-button
            id="apiKeyBannerChatGptButton"
            appearance="plain"
            size="s"
            @click=${() => this.signInChatGpt()}
          >
            ${waIcon('right-to-bracket', { slot: 'start' })}
            ${ONBOARDING_CHOICE_CHATGPT.label}
          </wa-button>
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
          A ChatGPT subscription covers OpenAI models. Other chat subscriptions
          don't include API access; for those models, use a provider key.
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
