/** Account identity, authentication, and included-access usage. */

// Third-party imports
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared webview
import { postMessage } from '@shared/hostBridge';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  commonViewStyles,
  designTokens,
  settingsBannerStyles,
} from '@shared/styles';
import type {
  SpendingStatus,
  SpendingStatusError,
} from '@shared/schemas/spendingStatus';
import type { SessionProblem } from '@shared/schemas/profileViewMessages';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { renderSettingsBanner } from '@shared/wa/settingsBanner';
import { renderSettingsSectionHeading } from '@shared/wa/settingsSection';

// Local imports - settings view components
import '../components/profile/RelayQuotaMeter';

@customElement('account-tab')
export class AccountTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    settingsBannerStyles,
    css`
      :host {
        display: block;
      }

      .account-page {
        display: block;
      }

      .account-tier {
        text-transform: capitalize;
      }

      .account-empty {
        padding: var(--wa-space-m);
        border: var(--border-thin) solid var(--border-hairline);
        border-radius: var(--wa-border-radius-m);
        color: var(--wa-color-text-quiet);
        background: var(--wa-color-surface-lowered);
        font-size: var(--font-size-sm);
      }
    `,
  ];

  @property({ type: Boolean }) authenticated = false;
  @property({ attribute: false }) userEmail = '';
  @property({ attribute: false }) tier = 'free';
  @property({ attribute: false }) sessionProblem: SessionProblem | null = null;
  @property({ attribute: false }) spendingStatus: SpendingStatus | null = null;
  @property({ attribute: false })
  spendingStatusError: SpendingStatusError | null = null;
  @property({ type: Boolean }) quotaAutoSwitched = false;
  @property({ type: Boolean }) vscodeSettingsAvailable = false;
  @property({ attribute: false }) apiAccessMode: 'included' | 'personal' =
    'personal';

  private readonly handleSignIn = (): void => {
    postMessage(SETTINGS_VIEW_COMMANDS.SIGN_IN);
  };

  private readonly handleSignOut = (): void => {
    postMessage(SETTINGS_VIEW_COMMANDS.SIGN_OUT);
  };

  private readonly handleOpenVscodeSettings = (): void => {
    postMessage(SETTINGS_VIEW_COMMANDS.OPEN_VSCODE_SETTINGS);
  };

  private handleManageProviderKeys(): void {
    this.dispatchEvent(
      new CustomEvent('manage-provider-keys', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private renderUsage(): TemplateResult {
    // Session and spend-check failures take priority over stale usage data.
    if (this.sessionProblem === 'expired') {
      return html`
        <div class="account-empty">
          Usage data can't load because your session has expired. Sign in again
          to reconnect.
        </div>
      `;
    }
    if (this.sessionProblem === 'unavailable') {
      return html`
        <div class="account-empty">
          Usage data can't load because the authentication service is
          temporarily unavailable. Try again later.
        </div>
      `;
    }
    if (this.spendingStatusError != null) {
      return html`
        <div class="account-empty">
          Usage check failed on the server. Included access is temporarily
          unavailable; switch to your own provider API keys or try again later.
        </div>
      `;
    }
    if (!this.authenticated) {
      return html`
        <div class="account-empty">
          Sign in to monitor your included TeXRA usage and monthly relay quota.
        </div>
      `;
    }
    // After a quota-exhaustion auto-switch (included -> personal) the meter
    // stays visible: it carries the "switched you to your own keys" notice.
    if (this.apiAccessMode !== 'included' && !this.quotaAutoSwitched) {
      return html`
        <div class="account-empty">
          Included model access is not enabled. Switch to included access in
          Providers &amp; Models to see usage data.
        </div>
      `;
    }
    if (this.spendingStatus == null) {
      return html`
        <div class="account-empty">
          Usage data is not available for this account.
        </div>
      `;
    }
    return html`
      <relay-quota-meter
        .status=${this.spendingStatus}
        .autoSwitched=${this.quotaAutoSwitched}
      ></relay-quota-meter>
    `;
  }

  private renderIdentityBanner(): TemplateResult {
    const expired = this.sessionProblem === 'expired';
    const unavailable = this.sessionProblem === 'unavailable';
    // Unavailable and expired sessions retain the stored account label.
    const title =
      this.authenticated || expired || unavailable
        ? this.userEmail || 'TeXRA account'
        : 'TeXRA account';
    let description: TemplateResult | string =
      'Sign in to use included access and monitor usage.';
    if (expired) {
      description =
        'Your session has expired. Sign in again to restore included access and usage data.';
    } else if (unavailable) {
      description =
        'The authentication service is temporarily unavailable. Your stored session has not been removed.';
    } else if (this.authenticated) {
      description = html`<span class="account-tier">${this.tier}</span> plan`;
    }
    // An expired session offers explicit recovery and cleanup. A transient
    // outage offers neither action, because the stored credential is retained.
    let actions: TemplateResult | typeof nothing;
    if (expired) {
      actions = html`
        <wa-tag variant="warning">Session expired</wa-tag>
        ${renderLabeledActionButton({
          icon: 'user',
          text: 'Sign in',
          kind: 'primary',
          appearance: 'filled',
          onClick: this.handleSignIn,
        })}
        ${renderLabeledActionButton({
          icon: 'right-from-bracket',
          text: 'Sign out',
          kind: 'secondary',
          appearance: 'outlined',
          onClick: this.handleSignOut,
        })}
      `;
    } else if (unavailable) {
      actions = nothing;
    } else if (this.authenticated) {
      actions = html`
        <wa-tag variant="success">Connected</wa-tag>
        ${renderLabeledActionButton({
          icon: 'right-from-bracket',
          text: 'Sign out',
          kind: 'secondary',
          appearance: 'outlined',
          onClick: this.handleSignOut,
        })}
      `;
    } else {
      actions = renderLabeledActionButton({
        icon: 'user',
        text: 'Sign in',
        kind: 'primary',
        appearance: 'filled',
        onClick: this.handleSignIn,
      });
    }
    return renderSettingsBanner({
      id: 'account-identity-banner',
      icon: 'circle-user',
      title,
      description,
      actions,
    });
  }

  override render(): TemplateResult {
    return html`
      <div class="account-page tab-content-container">
        ${this.renderIdentityBanner()}

        <section>
          ${renderSettingsSectionHeading({
            title: 'Included access usage',
            description:
              'Monthly usage for models provided through your TeXRA plan.',
          })}
          ${this.renderUsage()}
        </section>

        <section>
          ${renderSettingsSectionHeading({
            title: 'Credentials',
            description:
              'Provider API keys remain in Providers & Models, alongside the models that use them.',
          })}
          <div class="settings-section">
            <div class="settings-row">
              <div class="settings-row-text">
                <span class="settings-row-label">Provider API keys</span>
                <span class="settings-row-help">
                  Configure OpenAI, Anthropic, Google, and other providers.
                </span>
              </div>
              <div class="settings-row-control">
                ${renderLabeledActionButton({
                  icon: 'key',
                  text: 'Manage keys',
                  kind: 'secondary',
                  appearance: 'outlined',
                  onClick: () => this.handleManageProviderKeys(),
                })}
              </div>
            </div>
            ${
              this.vscodeSettingsAvailable
                ? html`
                    <div class="settings-row">
                      <div class="settings-row-text">
                        <span class="settings-row-label">
                          VS Code settings
                        </span>
                        <span class="settings-row-help">
                          Open host-level TeXRA configuration.
                        </span>
                      </div>
                      <div class="settings-row-control">
                        ${renderLabeledActionButton({
                          icon: 'gear',
                          text: 'Open settings',
                          kind: 'secondary',
                          appearance: 'outlined',
                          onClick: this.handleOpenVscodeSettings,
                        })}
                      </div>
                    </div>
                  `
                : nothing
            }
          </div>
        </section>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'account-tab': AccountTab;
  }
}
