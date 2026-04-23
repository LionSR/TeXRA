/**
 * Banner component for the Researcher Access Program sign-in.
 *
 * Displays an info banner encouraging users to sign in for
 * access to AI models without their own API keys.
 *
 * @fires sign-in - When sign in button is clicked
 * @fires dismiss-login - When dismiss button is clicked
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens, codiconStyles, commonViewStyles } from '@shared/styles';

// Local imports - shared copy
import { PROMO_NOTICE_SHORT } from '@shared/copy/promoNotice';

// Local imports - main view events
import { MainViewEvents } from '../events';
import { infoNoticeStyles } from '../styles/infoNoticeStyles';
import { renderInfoNotice } from './infoNotice';

@customElement('login-banner')
export class LoginBanner extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    commonViewStyles,
    infoNoticeStyles,
    css`
      .login-banner-icon {
        font-size: 1.5em;
        color: var(--vscode-button-background);
        display: flex;
        align-items: center;
      }

      .login-banner-text {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-tiny);
      }

      .login-banner-title {
        font-weight: var(--font-weight-semibold);
        font-size: 1em;
      }

      .login-banner-description {
        font-size: var(--font-size-sm);
        opacity: var(--opacity-normal);
      }
    `,
  ];

  @property({ type: Boolean }) visible = false;

  private handleSignIn(): void {
    this.dispatchEvent(MainViewEvents.signIn());
  }

  private handleDismiss(): void {
    this.dispatchEvent(MainViewEvents.dismissLogin());
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.visible) return nothing;

    return renderInfoNotice({
      id: 'loginBanner',
      ariaLabel: 'Sign in to access researcher program features',
      variant: 'banner',
      leading: html`
        <span class="login-banner-icon"
          ><i class="codicon codicon-sparkle"></i
        ></span>
      `,
      content: html`
        <div class="login-banner-text">
          <span class="login-banner-title">Researcher Access Program</span>
          <span class="login-banner-description">${PROMO_NOTICE_SHORT}</span>
        </div>
      `,
      actions: html`
        <vscode-button
          id="loginBannerButton"
          appearance="primary"
          @click=${this.handleSignIn}
        >
          <span slot="start" class="codicon codicon-sign-in"></span>
          Sign In
        </vscode-button>
      `,
      dismiss: {
        title: 'Dismiss (can be re-enabled in settings)',
        ariaLabel: 'Dismiss login banner',
        onDismiss: this.handleDismiss,
      },
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'login-banner': LoginBanner;
  }
}
