/** Grok (xAI SuperGrok) subscription sign-in and routing preference. */

import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { xaiAccountLabel } from '@auth/xai/xaiSessionTypes';
import { commonViewStyles, designTokens } from '@shared/styles';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import type { GrokAuthStatus } from '@shared/schemas';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import {
  renderSettingsSectionHeading,
  renderSettingsToggleRow,
} from '@shared/wa/settingsSection';
import { waIcon } from '@shared/wa/webAwesomeIcons';

import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';

import type WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';

/**
 * Experimental "Sign in with Grok" control. After sign-in, xAI models can run
 * on the user's SuperGrok / xAI account OAuth token when
 * `xaiGrok.preferSubscription` is enabled.
 */
@customElement('grok-subscription-section')
export class GrokSubscriptionSection extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }
    `,
  ];

  @property({ attribute: false }) grokAuth: GrokAuthStatus | null = null;

  private readonly handlePreferSubscriptionChange = (event: Event): void => {
    const enabled = (event.target as WaSwitch).checked;
    postMessage(SETTINGS_VIEW_COMMANDS.SET_GROK_PREFER_SUBSCRIPTION, {
      enabled,
    });
  };

  override render(): TemplateResult {
    const signedIn = this.grokAuth?.signedIn ?? false;
    const preferSubscription = this.grokAuth?.preferSubscription ?? false;
    const account = xaiAccountLabel(this.grokAuth);
    return html`
      <section id="grok-subscription">
        ${renderSettingsSectionHeading({
          title: 'Grok subscription',
          description:
            'Use xAI Grok models through your SuperGrok / xAI account. No xAI API key is needed.',
          icon: 'circle-user',
          actions: html`<wa-tag variant="neutral" size="s"
            >Experimental</wa-tag
          >`,
        })}
        <p class="keyless-source__limit">
          ${waIcon('circle-info')}
          <span>
            Uses the public Grok CLI OAuth client. xAI may change or revoke that
            registration without notice.
          </span>
        </p>
        <div class="settings-section">
          ${renderSettingsToggleRow({
            label: 'Prefer Grok subscription',
            description: 'Use the subscription instead of an xAI API key.',
            checked: preferSubscription,
            onChange: this.handlePreferSubscriptionChange,
          })}
          <div class="settings-row">
            <div class="settings-row-text">
              <span class="settings-row-label">
                ${
                  signedIn
                    ? html`${waIcon('circle-check')} Signed in as ${account}`
                    : 'Grok account'
                }
              </span>
              <span class="settings-row-help">
                ${
                  signedIn
                    ? 'Your subscription is ready to use.'
                    : 'Connect the xAI account that owns your SuperGrok plan.'
                }
              </span>
            </div>
            <div class="settings-row-control">
              ${
                signedIn
                  ? renderLabeledActionButton({
                      text: 'Sign out',
                      kind: 'secondary',
                      appearance: 'outlined',
                      onClick: () =>
                        postMessage(SETTINGS_VIEW_COMMANDS.SIGN_OUT_GROK),
                    })
                  : renderLabeledActionButton({
                      icon: 'right-to-bracket',
                      text: 'Sign in with Grok',
                      kind: 'primary',
                      appearance: 'filled',
                      onClick: () =>
                        postMessage(SETTINGS_VIEW_COMMANDS.SIGN_IN_GROK),
                    })
              }
            </div>
          </div>
        </div>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'grok-subscription-section': GrokSubscriptionSection;
  }
}
