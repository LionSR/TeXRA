// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens, commonViewStyles, codiconStyles } from '@shared/styles';

// Local imports - main view
import { mainViewStyles } from '@webview/frontend/styles';

export type LoginBannerAction = 'sign-in' | 'dismiss';

export interface LoginBannerActionDetail {
  action: LoginBannerAction;
}

@customElement('login-banner')
export class LoginBanner extends LitElement {
  static styles = [
    designTokens,
    commonViewStyles,
    codiconStyles,
    mainViewStyles,
  ];

  @property({ type: Boolean }) visible = false;

  private emitAction(action: LoginBannerAction): void {
    this.dispatchEvent(
      new CustomEvent<LoginBannerActionDetail>('login-banner-action', {
        detail: { action },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleActionClick = (event: Event): void => {
    const target = event.currentTarget as HTMLElement | null;
    const action = target?.dataset.action as LoginBannerAction | undefined;
    if (!action) return;
    this.emitAction(action);
  };

  render(): TemplateResult {
    return html`
      <div
        id="loginBanner"
        class="login-banner"
        style=${this.visible ? 'display: flex' : 'display: none'}
      >
        <div class="login-banner-content">
          <span class="login-banner-icon"
            ><i class="codicon codicon-sparkle"></i
          ></span>
          <div class="login-banner-text">
            <span class="login-banner-title">Researcher Access Program</span>
            <span class="login-banner-description">
              Sign in to access AI models and remote agents without your own API
              keys.
            </span>
          </div>
        </div>
        <div class="actions">
          <vscode-button
            id="loginBannerButton"
            appearance="primary"
            data-action="sign-in"
            @click=${this.handleActionClick}
          >
            <span slot="start" class="codicon codicon-sign-in"></span>
            Sign In
          </vscode-button>
          <vscode-toolbar-button
            id="loginBannerDismissButton"
            icon="close"
            title="Dismiss (can be re-enabled in settings)"
            aria-label="Dismiss login banner"
            data-action="dismiss"
            @click=${this.handleActionClick}
          ></vscode-toolbar-button>
        </div>
      </div>
    `;
  }
}
