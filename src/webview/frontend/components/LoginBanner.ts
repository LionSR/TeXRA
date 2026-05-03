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

@customElement('login-banner')
export class LoginBanner extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .login-banner {
        background: var(--texra-inputValidation-infoBackground);
        color: var(--texra-inputValidation-infoForeground);
        border: var(--border-thin) solid var(--texra-inputValidation-infoBorder);
        border-radius: var(--border-radius);
        padding: var(--spacing-medium);
        margin-bottom: var(--spacing-large);
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--spacing-medium);
      }

      .login-banner-content {
        display: flex;
        align-items: center;
        gap: var(--spacing-medium);
        flex: 1;
      }

      .login-banner-icon {
        font-size: 1.5em;
        color: var(--texra-button-background);
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

      .login-banner .actions {
        flex-shrink: 0;
      }

      .actions {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
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

    return html`
      <div id="loginBanner" class="login-banner">
        <div class="login-banner-content">
          <span class="login-banner-icon"
            ><i class="codicon codicon-sparkle"></i
          ></span>
          <div class="login-banner-text">
            <span class="login-banner-title">Researcher Access Program</span>
            <span class="login-banner-description">
              ${PROMO_NOTICE_SHORT}
            </span>
          </div>
        </div>
        <div class="actions">
          <vscode-button
            id="loginBannerButton"
            appearance="primary"
            @click=${this.handleSignIn}
          >
            <span slot="start" class="codicon codicon-sign-in"></span>
            Sign In
          </vscode-button>
          <vscode-toolbar-button
            id="loginBannerDismissButton"
            icon="close"
            title="Dismiss (can be re-enabled in settings)"
            aria-label="Dismiss login banner"
            @click=${this.handleDismiss}
          ></vscode-toolbar-button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'login-banner': LoginBanner;
  }
}
