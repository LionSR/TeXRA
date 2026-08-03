/** ChatGPT subscription sign-in and routing preference. */

import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared auth
import { codexAccountLabel } from '@auth/codex/codexSessionTypes';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import type { ChatGptAuthStatus } from '@shared/schemas';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { renderSettingsSectionHeading } from '@shared/wa/settingsSection';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';

// Local imports - shared schemas

import type WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';

/**
 * Experimental "Sign in with ChatGPT" control. After sign-in, the configured
 * Codex-eligible models run on the user's own ChatGPT subscription (when
 * `chatgptCodex.preferSubscription` is enabled) instead of an API key.
 */
@customElement('codex-subscription-section')
export class CodexSubscriptionSection extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .keyless-source__limit {
        display: flex;
        align-items: flex-start;
        gap: var(--wa-space-xs);
        margin: 0 0 var(--wa-space-xs);
        opacity: 0.85;
        font-size: var(--font-size-sm);
      }
      .keyless-source__limit wa-icon {
        flex: 0 0 auto;
        margin-top: var(--wa-space-3xs);
      }
    `,
  ];

  @property({ attribute: false }) chatgptAuth: ChatGptAuthStatus | null = null;

  private readonly handlePreferSubscriptionChange = (event: Event): void => {
    const enabled = (event.target as WaSwitch).checked;
    postMessage(SETTINGS_VIEW_COMMANDS.SET_CHATGPT_PREFER_SUBSCRIPTION, {
      enabled,
    });
  };

  override render(): TemplateResult {
    const signedIn = this.chatgptAuth?.signedIn ?? false;
    const preferSubscription = this.chatgptAuth?.preferSubscription ?? false;
    const account = codexAccountLabel(this.chatgptAuth);
    return html`
      <section id="chatgpt-subscription">
        ${renderSettingsSectionHeading({
          title: 'ChatGPT subscription',
          description:
            'Use OpenAI models through your ChatGPT Plus, Pro, or Team subscription. No OpenAI API key is needed.',
          actions: html`<wa-tag variant="neutral" size="s"
            >Experimental</wa-tag
          >`,
        })}
        <p class="keyless-source__limit">
          ${waIcon('circle-info')}
          <span>
            Subscription routing currently uses a 272,000-token Codex context
            cap, not the full 1,000,000-token API context.
          </span>
        </p>
        <div class="settings-section">
          <div class="settings-row">
            <div class="settings-row-text">
              <span class="settings-row-label">
                Prefer ChatGPT subscription
              </span>
              <span class="settings-row-help">
                Route eligible Codex models through your subscription.
              </span>
            </div>
            <wa-switch
              class="settings-row-control"
              aria-label="Prefer ChatGPT subscription"
              ?checked=${preferSubscription}
              @change=${this.handlePreferSubscriptionChange}
            ></wa-switch>
          </div>
          <div class="settings-row">
            <div class="settings-row-text">
              <span class="settings-row-label">
                ${
                  signedIn
                    ? html`${waIcon('circle-check')} Signed in as ${account}`
                    : 'ChatGPT account'
                }
              </span>
              <span class="settings-row-help">
                ${
                  signedIn
                    ? 'Your subscription is ready to use.'
                    : 'Connect the ChatGPT account that owns your subscription.'
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
                        postMessage(SETTINGS_VIEW_COMMANDS.SIGN_OUT_CHATGPT),
                    })
                  : renderLabeledActionButton({
                      icon: 'comments',
                      text: 'Sign in with ChatGPT',
                      kind: 'primary',
                      appearance: 'filled',
                      onClick: () =>
                        postMessage(SETTINGS_VIEW_COMMANDS.SIGN_IN_CHATGPT),
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
    'codex-subscription-section': CodexSubscriptionSection;
  }
}
