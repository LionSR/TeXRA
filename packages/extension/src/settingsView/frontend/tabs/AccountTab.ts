/** Account identity, authentication, and included-access usage. */

// Third-party imports
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared webview
import { postMessage } from '@shared/hostBridge';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { commonViewStyles, designTokens } from '@shared/styles';
import type { SpendingStatus } from '@shared/schemas/spendingStatus';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Local imports - settings view components
import '../components/profile/RelayQuotaMeter';

@customElement('account-tab')
export class AccountTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .account-page {
        display: grid;
        gap: var(--wa-space-l);
      }

      .account-identity {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: center;
        gap: var(--wa-space-s);
        padding: var(--wa-space-l);
        border: var(--border-thin) solid var(--border-hairline);
        border-radius: var(--wa-border-radius-l);
        background: var(--wa-color-surface-lowered);
      }

      .account-copy {
        min-width: 0;
      }

      .account-title {
        margin: 0;
        color: var(--wa-color-text-normal);
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-semibold);
      }

      .account-detail {
        margin: var(--wa-space-3xs) 0 0;
        overflow: hidden;
        color: var(--wa-color-text-quiet);
        font-size: var(--font-size-sm);
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .account-tier {
        text-transform: capitalize;
      }

      .account-actions {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
      }

      .account-section {
        display: grid;
        gap: var(--wa-space-xs);
      }

      .account-section-heading {
        margin: 0;
        color: var(--wa-color-text-normal);
        font-size: var(--font-size);
        font-weight: var(--font-weight-semibold);
      }

      .account-section-description {
        margin: 0;
        color: var(--wa-color-text-quiet);
        font-size: var(--font-size-sm);
        line-height: var(--line-height-relaxed);
      }

      .account-empty {
        padding: var(--wa-space-m);
        border: var(--border-thin) solid var(--border-hairline);
        border-radius: var(--wa-border-radius-m);
        color: var(--wa-color-text-quiet);
        background: var(--wa-color-surface-lowered);
        font-size: var(--font-size-sm);
      }

      .account-settings {
        border-top: var(--border-thin) solid var(--border-hairline);
      }

      @container settings (max-width: 520px) {
        .account-identity {
          grid-template-columns: auto minmax(0, 1fr);
          padding: var(--wa-space-m);
        }

        .account-actions {
          grid-column: 1 / -1;
          justify-content: flex-end;
        }
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

  override render(): TemplateResult {
    const identity = this.authenticated
      ? html`
          <h2 class="account-title">${this.userEmail || 'TeXRA account'}</h2>
          <p class="account-detail">
            <span class="account-tier">${this.tier}</span> plan
          </p>
        `
      : html`
          <h2 class="account-title">TeXRA account</h2>
          <p class="account-detail">
            Sign in to use included access and monitor usage.
          </p>
        `;

    return html`
      <div class="account-page tab-content-container">
        <section class="account-identity">
          <span class="icon-surface is-size-l"> ${waIcon('circle-user')} </span>
          <div class="account-copy">${identity}</div>
          <div class="account-actions">
            ${
              this.authenticated
                ? html`
                    <wa-tag variant="success">Connected</wa-tag>
                    <wa-button
                      appearance="outlined"
                      variant="neutral"
                      size="s"
                      @click=${this.handleSignOut}
                    >
                      ${waIcon('right-from-bracket', { slot: 'start' })} Sign
                      out
                    </wa-button>
                  `
                : html`
                    <wa-button
                      appearance="filled"
                      variant="brand"
                      size="s"
                      @click=${this.handleSignIn}
                    >
                      ${waIcon('user', { slot: 'start' })} Sign in
                    </wa-button>
                  `
            }
          </div>
        </section>

        <section class="account-section">
          <h3 class="account-section-heading">Included access usage</h3>
          <p class="account-section-description">
            Monthly usage for models provided through your TeXRA plan.
          </p>
          ${this.renderUsage()}
        </section>

        <section class="account-section">
          <h3 class="account-section-heading">Credentials</h3>
          <p class="account-section-description">
            Provider API keys remain in Models & Access, alongside the models
            that use them.
          </p>
          <div class="account-settings">
            <div class="settings-row">
              <div class="settings-row-text">
                <span class="settings-row-label">Provider API keys</span>
                <span class="settings-row-help">
                  Configure OpenAI, Anthropic, Google, and other providers.
                </span>
              </div>
              <wa-button
                class="account-manage-keys"
                appearance="outlined"
                variant="neutral"
                size="s"
                @click=${this.handleManageProviderKeys}
              >
                ${waIcon('key', { slot: 'start' })} Manage keys
              </wa-button>
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
                      <wa-button
                        appearance="outlined"
                        variant="neutral"
                        size="s"
                        @click=${this.handleOpenVscodeSettings}
                      >
                        ${waIcon('gear', { slot: 'start' })} Open settings
                      </wa-button>
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
