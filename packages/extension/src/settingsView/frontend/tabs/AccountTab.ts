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
import type { SpendingStatus } from '@shared/schemas/spendingStatus';
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
  @property({ attribute: false }) spendingStatus: SpendingStatus | null = null;
  @property({ type: Boolean }) quotaAutoSwitched = false;
  @property({ type: Boolean }) vscodeSettingsAvailable = false;

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
    if (!this.authenticated) {
      return html`
        <div class="account-empty">
          Sign in to monitor your included TeXRA usage and monthly relay quota.
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
    const title = this.authenticated
      ? this.userEmail || 'TeXRA account'
      : 'TeXRA account';
    const description = this.authenticated
      ? html`<span class="account-tier">${this.tier}</span> plan`
      : 'Sign in to use included access and monitor usage.';
    const actions = this.authenticated
      ? html`
          <wa-tag variant="success">Connected</wa-tag>
          ${renderLabeledActionButton({
            icon: 'right-from-bracket',
            text: 'Sign out',
            kind: 'secondary',
            appearance: 'outlined',
            onClick: this.handleSignOut,
          })}
        `
      : renderLabeledActionButton({
          icon: 'user',
          text: 'Sign in',
          kind: 'primary',
          appearance: 'filled',
          onClick: this.handleSignIn,
        });
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
