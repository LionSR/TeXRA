/**
 * Subscription sign-in and routing preference for one provider.
 *
 * ChatGPT (Codex) and Grok (xAI) render the identical section — a "prefer this
 * subscription" switch plus a sign-in/sign-out account row — so the markup is
 * written once. Its words are the account copy every host shows
 * (`SUBSCRIPTION_AUTH_COPY`) and the switch's setting row; the descriptor
 * ({@link SubscriptionSectionProvider}) holds only what differs otherwise.
 */

import { html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared auth

// Local imports - shared styles
import {
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING,
  CHATGPT_PREFER_SUBSCRIPTION_SETTING,
  type SettingRow,
  type SubscriptionAuthProvider,
  XAI_PREFER_SUBSCRIPTION_SETTING,
} from '@texra-ai/worldline/schemas';
import WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';
import {
  subscriptionAccountLabel,
  type SubscriptionAuthStatus,
} from '@texra/shared/model/subscriptionAuthStatus';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import { postToHost } from '@ui/settings/messageDispatcher';
import { ACCOUNT_OUTCOME, SUBSCRIPTION_AUTH_COPY } from '@ui/copy/accountAuth';
import { TexraSignalElement } from '@ui/litBase';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import {
  renderSettingsSectionHeading,
  renderSettingsToggleRow,
} from '@ui/wa/settingsSection';
import { renderStatusBadge } from '@ui/wa/statusIcons';
import { waIcon } from '@ui/wa/webAwesomeIcons';

// Local imports - settings view components
import {
  postStateSetting,
  renderStateSettingNumberRow,
} from '../shared/stateSettingRows';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

/** Everything one provider contributes to the shared section. */
interface SubscriptionSectionProvider {
  /** DOM id of the rendered `<section>`, used by settings deep links. */
  readonly sectionId: string;
  /** Caveat shown under the heading (client registration, …). */
  readonly note?: string;
  /** The routing switch, whose title and description the switch shows. */
  readonly preference: SettingRow<boolean>;
  /** The provider the section's sign-in, sign-out and preference commands address. */
  readonly providerId: SubscriptionAuthStatus['provider'];
  /** Optional advanced input-budget control for this subscription route. */
  readonly contextWindowSetting?: typeof CHATGPT_CODEX_CONTEXT_WINDOW_SETTING;
}

@customElement('subscription-section')
export class SubscriptionSection extends TexraSignalElement {
  static override styles = [
    TexraSignalElement.styles,
    css`
      :host {
        display: block;
      }

      /* Quiet limitation note under a keyless (subscription-backed) source. */
      .keyless-source__limit {
        display: flex;
        align-items: flex-start;
        gap: var(--wa-space-xs);
        margin: 0 0 var(--wa-space-xs);
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
      }
      .keyless-source__limit wa-icon {
        flex: 0 0 auto;
        margin-top: var(--wa-space-3xs);
      }
    `,
  ];

  @property({ attribute: false }) provider!: SubscriptionSectionProvider;
  @property({ attribute: false }) auth: SubscriptionAuthStatus | null = null;

  private readonly handlePreferSubscriptionChange = (event: Event): void => {
    if (!(event.target instanceof WaSwitch)) return;
    const enabled = event.target.checked;
    postToHost({
      command: SETTINGS_VIEW_COMMANDS.SET_SUBSCRIPTION_PREFERENCE,
      provider: this.provider.providerId,
      enabled,
    });
  };

  override render(): TemplateResult {
    const provider = this.provider;
    const copy = SUBSCRIPTION_AUTH_COPY[provider.providerId];
    const headingId = `${provider.sectionId}-heading`;
    const contextWindowSetting = provider.contextWindowSetting;
    const signedIn = this.auth?.signedIn ?? false;
    const preferSubscription = this.auth?.preferSubscription ?? false;
    const account = subscriptionAccountLabel(
      provider.providerId,
      this.auth ?? {},
    );
    return html`
      <section id=${provider.sectionId} aria-labelledby=${headingId}>
        ${renderSettingsSectionHeading({
          id: headingId,
          title: copy.subscriptionLabel,
          description: copy.connect.description,
          icon: 'circle-user',
          actions: renderStatusBadge({ label: 'Experimental' }),
        })}
        ${
          provider.note
            ? html`<p class="keyless-source__limit">
                ${waIcon('circle-info')}
                <span>${provider.note}</span>
              </p>`
            : nothing
        }
        <div class="settings-section">
          ${renderSettingsToggleRow({
            label: provider.preference.title,
            description: provider.preference.description,
            checked: preferSubscription,
            onChange: this.handlePreferSubscriptionChange,
          })}
          <div class="settings-row">
            <div class="settings-row-text">
              <span class="settings-row-label" aria-live="polite">
                ${
                  signedIn
                    ? html`${waIcon('circle-check')}
                        <bdi dir="auto"
                          >${ACCOUNT_OUTCOME.signedInAs(
                            copy.label,
                            account,
                          ).replace(/\.$/, '')}</bdi
                        >`
                    : 'Account'
                }
              </span>
              <span class="settings-row-help">
                ${
                  signedIn
                    ? 'Your subscription is ready to use.'
                    : copy.signInDescription
                }
              </span>
            </div>
            <div class="settings-row-control">
              ${
                signedIn
                  ? renderLabeledActionButton({
                      text: 'Sign out',
                      label: copy.signOutLabel,
                      kind: 'secondary',
                      onClick: () =>
                        postToHost({
                          command: SETTINGS_VIEW_COMMANDS.SIGN_OUT_SUBSCRIPTION,
                          provider: provider.providerId,
                        }),
                    })
                  : renderLabeledActionButton({
                      icon: 'right-to-bracket',
                      text: copy.signInLabel,
                      kind: 'primary',
                      onClick: () =>
                        postToHost({
                          command: SETTINGS_VIEW_COMMANDS.SIGN_IN_SUBSCRIPTION,
                          provider: provider.providerId,
                        }),
                    })
              }
            </div>
          </div>
          ${
            // The long explanation lives in the docs (models.md) and the
            // catalog row; the card keeps one line.
            contextWindowSetting
              ? html`<wa-details class="panel-collapsible" summary="Advanced">
                  ${renderStateSettingNumberRow(contextWindowSetting, {
                    placeholder: 'Model default',
                    // An empty field is each model's own window.
                    onClear: () =>
                      postStateSetting(contextWindowSetting.key, null),
                  })}
                </wa-details>`
              : nothing
          }
        </div>
      </section>
    `;
  }
}

/** Each subscription's section, keyed by the provider it signs in to; a
 *  provider without a row here does not compile. */
export const SUBSCRIPTION_SECTIONS = Object.freeze({
  /**
   * Experimental "Sign in with ChatGPT". After sign-in, the configured
   * Codex-eligible models run on the user's ChatGPT subscription (when
   * `chatgptCodex.preferSubscription` is enabled) instead of an API key.
   */
  chatgpt: Object.freeze({
    sectionId: 'chatgpt-subscription',
    contextWindowSetting: CHATGPT_CODEX_CONTEXT_WINDOW_SETTING,
    preference: CHATGPT_PREFER_SUBSCRIPTION_SETTING,
    providerId: 'chatgpt',
  }),

  /**
   * Experimental "Sign in with Grok". After sign-in, xAI models can run on the
   * user's SuperGrok / xAI account OAuth token when `xaiGrok.preferSubscription`
   * is enabled.
   */
  grok: Object.freeze({
    sectionId: 'grok-subscription',
    note: 'Uses the public Grok CLI OAuth client, which xAI may change or revoke.',
    preference: XAI_PREFER_SUBSCRIPTION_SETTING,
    providerId: 'grok',
  }),
} satisfies {
  readonly [P in SubscriptionAuthProvider]: SubscriptionSectionProvider & {
    readonly providerId: P;
  };
});

declare global {
  interface HTMLElementTagNameMap {
    'subscription-section': SubscriptionSection;
  }
}
