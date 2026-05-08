import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { LitElement, html, css, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { designTokens, commonViewStyles } from '@shared/styles';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { PROMO_NOTICE_SHORT } from '@shared/copy/promoNotice';

import { bannerStyles } from '../styles/bannerStyles';
import { MainViewEvents } from '../events';

@customElement('login-banner')
export class LoginBanner extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    bannerStyles,
    css`
      .banner-text {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-3xs);
        min-width: 0;
      }

      .banner-title {
        font-weight: var(--font-weight-semibold);
        font-size: 1em;
      }

      .banner-description {
        font-size: var(--font-size-sm);
        opacity: var(--opacity-normal);
      }
    `,
  ];

  @property({ type: Boolean }) visible = false;

  override updated(changed: PropertyValues<this>): void {
    if (changed.has('visible')) {
      this.dataset.visible = this.visible ? 'true' : 'false';
      this.setAttribute('aria-hidden', this.visible ? 'false' : 'true');
    }
  }

  private handleSignIn(): void {
    this.dispatchEvent(MainViewEvents.signIn());
  }

  private handleDismiss(): void {
    this.dispatchEvent(MainViewEvents.dismissLogin());
  }

  override render(): TemplateResult {
    return html`
      <div class="banner-frame">
        <wa-callout id="loginBanner" variant="brand">
          ${waIcon('wand-magic-sparkles', { slot: 'icon' })}
          <div class="banner-row">
            <div class="banner-text">
              <span class="banner-title">Researcher Access Program</span>
              <span class="banner-description">${PROMO_NOTICE_SHORT}</span>
            </div>
            <div class="actions">
              <wa-button
                id="loginBannerButton"
                appearance="filled"
                variant="brand"
                size="small"
                @click=${this.handleSignIn}
              >
                ${waIcon('right-to-bracket', { slot: 'start' })} Sign In
              </wa-button>
              <wa-button
                id="loginBannerDismissButton"
                appearance="plain"
                size="small"
                title="Dismiss (can be re-enabled in settings)"
                aria-label="Dismiss login banner"
                @click=${this.handleDismiss}
              >
                ${waIcon('xmark')}
              </wa-button>
            </div>
          </div>
        </wa-callout>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'login-banner': LoginBanner;
  }
}
