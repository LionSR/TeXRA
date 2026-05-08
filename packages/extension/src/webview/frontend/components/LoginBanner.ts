import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import {
  LitElement,
  html,
  css,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { designTokens, commonViewStyles } from '@shared/styles';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { PROMO_NOTICE_SHORT } from '@shared/copy/promoNotice';

import { applyBannerVisibility, bannerStyles } from '../styles/bannerStyles';
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
        letter-spacing: -0.005em;
      }

      .banner-description {
        font-size: var(--font-size-sm);
        opacity: 0.78;
        line-height: var(--line-height-relaxed, 1.5);
      }

      /*
       * The Sign In CTA is the primary banner action across the whole UI —
       * polish it with a quiet brand glow on hover and a tighter chrome
       * than the surrounding plain dismiss button.
       */
      #loginBannerButton::part(base) {
        min-height: 26px;
        padding-inline: var(--wa-space-s);
        border-radius: var(--wa-border-radius-m, 6px);
        font-weight: var(--font-weight-semibold, 600);
        letter-spacing: 0.01em;
        box-shadow:
          0 1px 1px rgb(0 0 0 / 6%),
          inset 0 1px 0 rgb(255 255 255 / 12%);
        transition:
          filter 160ms ease,
          box-shadow 160ms ease,
          transform 120ms ease;
      }

      #loginBannerButton::part(base):hover {
        filter: brightness(1.06);
        transform: translateY(-0.5px);
        box-shadow:
          0 3px 8px
            color-mix(in srgb, var(--wa-color-brand-fill-loud) 28%, transparent),
          inset 0 1px 0 rgb(255 255 255 / 18%);
      }

      #loginBannerButton::part(base):active {
        transform: translateY(0.5px);
        filter: brightness(0.97);
      }
    `,
  ];

  @property({ type: Boolean }) visible = false;

  override updated(changed: PropertyValues<this>): void {
    if (changed.has('visible')) {
      applyBannerVisibility(this, this.visible);
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
