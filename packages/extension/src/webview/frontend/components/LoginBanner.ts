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
         so they can't be pushed off-screen. */
      .banner-header {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: var(--wa-space-3xs) var(--wa-space-xs);
      }

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
        opacity: var(--opacity-normal);
        line-height: var(--line-height-normal, 1.4);
      }

      .banner-fineprint {
        display: block;
        margin-top: var(--wa-space-3xs);
        font-size: var(--font-size-xs);
        opacity: var(--opacity-muted);
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
        <div class="banner-header">
          <span class="banner-title">Researcher Access Program</span>
          <div class="actions">
            <wa-button
              id="loginBannerButton"
              appearance="filled"
              variant="brand"
              size="small"
              @click=${this.handleSignIn}
            >
              Sign In
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
