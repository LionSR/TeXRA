import '@awesome.me/webawesome/dist/components/button/button.js';
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { designTokens, commonViewStyles, bannerStyles } from '@shared/styles';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { PROMO_NOTICE_SHORT } from '@shared/copy/promoNotice';

import { renderBannerFrame } from '@shared/wa/bannerFrame';
import { MainViewEvents } from '../events';

@customElement('login-banner')
export class LoginBanner extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    bannerStyles,
    css`
      /* Title and actions share one row so the buttons reuse the header's
         empty right side instead of occupying a row of their own. The title's
         min-content flex basis keeps the buttons pinned to the corner in
         narrow sidebars (the title wraps instead); the row itself only wraps
         when even the title's longest word no longer fits beside the buttons,
         so they can't be pushed off-screen. The shared .banner-row supplies
         the flex row. */
      .banner-title {
        flex: 1 1 min-content;
        font-weight: var(--font-weight-semibold);
        font-size: 1em;
        letter-spacing: -0.005em;
      }

      .banner-lead {
        display: block;
        margin-top: var(--wa-space-3xs);
        font-size: var(--font-size-sm);
        line-height: var(--line-height-normal, 1.4);
      }

      /* Terms the user is agreeing to. Was --font-size-xs (10.4px) at 0.6
         opacity on an already-translucent callout: 3.22:1. It now inherits the
         13px body size and takes its de-emphasis from the callout treatment,
         not from a second size step plus an alpha. */
      .banner-fineprint {
        display: block;
        margin-top: var(--wa-space-3xs);
        line-height: var(--line-height-normal, 1.4);
      }

      /* Pair the sparkle with the title row instead of centering it in the
         taller text block. */
      #loginBanner::part(icon) {
        align-self: flex-start;
        margin-block-start: 0.3em;
      }

      #loginBannerButton::part(base) {
        font-weight: var(--font-weight-semibold, 600);
        letter-spacing: 0.01em;
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) visible = false;

  private handleSignIn(): void {
    this.dispatchEvent(MainViewEvents.signIn());
  }

  private handleDismiss(): void {
    this.dispatchEvent(MainViewEvents.dismissLogin());
  }

  override render(): TemplateResult {
    return renderBannerFrame({
      id: 'loginBanner',
      variant: 'brand',
      icon: 'wand-magic-sparkles',
      body: html`
        <div class="banner-row">
          <span class="banner-title">Researcher Access Program</span>
          <div class="actions">
            <wa-button
              id="loginBannerButton"
              appearance="filled"
              variant="brand"
              size="s"
              @click=${this.handleSignIn}
            >
              Sign in
            </wa-button>
            <wa-button
              id="loginBannerDismissButton"
              appearance="plain"
              size="s"
              title="Dismiss (can be re-enabled in settings)"
              aria-label="Dismiss login banner"
              @click=${this.handleDismiss}
            >
              ${waIcon('xmark')}
            </wa-button>
          </div>
        </div>
        <span class="banner-lead">${PROMO_NOTICE_SHORT.lead}</span>
        <span class="banner-fineprint">${PROMO_NOTICE_SHORT.fineprint}</span>
      `,
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'login-banner': LoginBanner;
  }
}
