/** Account identity, authentication, and account connections. */

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
import type { SessionProblem } from '@shared/schemas';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { renderSettingsBanner } from '@shared/wa/settingsBanner';
import { renderSettingsSectionHeading } from '@shared/wa/settingsSection';
import { createEvent } from '@shared/utils/events';

// Local imports - catalog-driven settings rows
import { renderStateSettingToggleRow } from '../components/shared/stateSettingRows';

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
    `,
  ];

  @property({ type: Boolean }) authenticated = false;
  @property({ attribute: false }) userEmail = '';
  @property({ attribute: false }) sessionProblem: SessionProblem | null = null;
  @property({ type: Boolean }) telemetryEnabled = true;

  private readonly handleSignIn = (): void => {
    postMessage(SETTINGS_VIEW_COMMANDS.SIGN_IN);
  };

  private readonly handleSignOut = (): void => {
    postMessage(SETTINGS_VIEW_COMMANDS.SIGN_OUT);
  };

  private handleManageProviderKeys(): void {
    this.dispatchEvent(createEvent('manage-provider-keys'));
  }

  private renderIdentityBanner(): TemplateResult {
    const expired = this.sessionProblem === 'expired';
    const unavailable = this.sessionProblem === 'unavailable';
    // Unavailable and expired sessions retain the stored account label.
    const hasStoredAccount = this.authenticated || expired || unavailable;
    const title =
      hasStoredAccount && this.userEmail ? this.userEmail : 'TeXRA account';
    let description: TemplateResult | string =
      'Sign in to use the hosted research-agent catalog.';
    if (expired) {
      description =
        'Your session has expired. Sign in again to restore your account connection.';
    } else if (unavailable) {
      description =
        'The authentication service is temporarily unavailable. Your stored session has not been removed.';
    } else if (this.authenticated) {
      description = 'Signed in.';
    }
    // An expired session offers explicit recovery and cleanup. A transient
    // outage offers neither action, because the stored credential is retained.
    let actions: TemplateResult | typeof nothing;
    if (expired) {
      actions = html`
        <wa-tag variant="warning" size="s">Session expired</wa-tag>
        ${renderLabeledActionButton({
          icon: 'right-to-bracket',
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
        <wa-tag variant="success" size="s">Connected</wa-tag>
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
        icon: 'right-to-bracket',
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
            title: 'Credentials',
            description:
              'Provider API keys remain in Providers & Models, alongside the models that use them.',
            icon: 'key',
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
          </div>
        </section>

        <section>
          ${renderSettingsSectionHeading({
            title: 'Privacy',
            description: 'Choose what TeXRA records about your model usage.',
            icon: 'shield',
          })}
          <div class="settings-section">
            ${renderStateSettingToggleRow({
              key: 'texra.telemetry.enabled',
              label: 'Share usage telemetry',
              description:
                'Sends model, token, cost, timing, and host metadata. Prompt text, document content, and file names are never sent. Turning this off stops reporting for rounds billed to your own API keys; rounds covered by a subscription are still recorded, because they meter your usage against your plan.',
              checked: this.telemetryEnabled,
            })}
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
