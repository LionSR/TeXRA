import '@awesome.me/webawesome/dist/components/button/button.js';
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
import { capitalize } from '@utils/text/stringUtils';
import { bannerStyles } from '../styles/bannerStyles';
import { renderWarningBanner } from './bannerFrame';
import { MainViewEvents } from '../events';

@customElement('api-key-banner')
export class ApiKeyBanner extends LitElement {
  static override styles = [designTokens, commonViewStyles, bannerStyles];

  @property({ attribute: false }) state: ApiKeyBannerState = {
    visible: false,
  };

  /** Reflected to the host so bannerStyles can hide the banner via CSS. */
  @property({ type: Boolean, reflect: true }) visible = false;

  override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('state')) {
      this.visible = this.state.visible;
    }
  }

  private handleAction(action: 'set' | 'guide'): void {
    const provider = this.state.provider ?? '';
    this.dispatchEvent(MainViewEvents.apiKeyAction({ action, provider }));
  }

  override render(): TemplateResult {
    const provider = this.state.provider ?? '';
    const providerLabel = provider ? capitalize(provider) : '';

    return renderWarningBanner({
      id: 'apiKeyBanner',
      body: html`
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
          Except for Codex models through ChatGPT subscription, chat
          subscriptions do not include API access. Use a provider developer key
          for other models.
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
