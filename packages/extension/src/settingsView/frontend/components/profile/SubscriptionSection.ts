/**
 * Subscription sign-in and routing preference for one provider.
 *
 * ChatGPT (Codex) and Grok (xAI) render the identical section — a "prefer this
 * subscription" switch plus a sign-in/sign-out account row — so the copy, the
 * three commands, and the account-label function are a descriptor
 * ({@link SubscriptionSectionProvider}) and the markup is written once.
 */

import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared auth
import { codexAccountLabel } from '@auth/codex/codexSessionTypes';
import { xaiAccountLabel } from '@auth/xai/xaiSessionTypes';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import type {
  ChatGptAuthStatus,
  GrokAuthStatus,
  SubscriptionUsageSnapshot,
} from '@shared/schemas';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import {
  renderSettingsSectionHeading,
  renderSettingsToggleRow,
} from '@shared/wa/settingsSection';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';

import type WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';

import './SubscriptionUsageRow';

/** Sign-in status shared by every subscription provider. */
export type SubscriptionAuthStatus = ChatGptAuthStatus | GrokAuthStatus;

/** Everything one provider contributes to the shared section. */
export interface SubscriptionSectionProvider {
  /** DOM id of the rendered `<section>`, used by settings deep links. */
  readonly sectionId: string;
  readonly title: string;
  readonly description: string;
  /** Caveat shown under the heading (context cap, client registration, …). */
  readonly note: string;
  readonly preferLabel: string;
  readonly preferDescription: string;
  /** Account-row label while signed out. */
  readonly accountTitle: string;
  /** Account-row help while signed out. */
  readonly connectDescription: string;
  readonly signInText: string;
  readonly commands: {
    readonly setPreferSubscription: string;
    readonly signIn: string;
    readonly signOut: string;
  };
  /** Human-readable account name for the signed-in row. */
  readonly accountLabel: (auth: SubscriptionAuthStatus | null) => string;
}

@customElement('subscription-section')
export class SubscriptionSection extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }
    `,
  ];

  @property({ attribute: false }) provider!: SubscriptionSectionProvider;
  @property({ attribute: false }) auth: SubscriptionAuthStatus | null = null;
  @property({ attribute: false }) usage: SubscriptionUsageSnapshot | null =
    null;

  private readonly handlePreferSubscriptionChange = (event: Event): void => {
    const enabled = (event.target as WaSwitch).checked;
    postMessage(this.provider.commands.setPreferSubscription, { enabled });
  };

  override render(): TemplateResult {
    const provider = this.provider;
    const signedIn = this.auth?.signedIn ?? false;
    const preferSubscription = this.auth?.preferSubscription ?? false;
    const account = provider.accountLabel(this.auth);
    return html`
      <section id=${provider.sectionId}>
        ${renderSettingsSectionHeading({
          title: provider.title,
          description: provider.description,
          icon: 'circle-user',
          actions: html`<wa-tag variant="neutral" size="s"
            >Experimental</wa-tag
          >`,
        })}
        <p class="keyless-source__limit">
          ${waIcon('circle-info')}
          <span>${provider.note}</span>
        </p>
        <div class="settings-section">
          ${renderSettingsToggleRow({
            label: provider.preferLabel,
            description: provider.preferDescription,
            checked: preferSubscription,
            onChange: this.handlePreferSubscriptionChange,
          })}
          <div class="settings-row">
            <div class="settings-row-text">
              <span class="settings-row-label">
                ${
                  signedIn
                    ? html`${waIcon('circle-check')} Signed in as ${account}`
                    : provider.accountTitle
                }
              </span>
              <span class="settings-row-help">
                ${
                  signedIn
                    ? 'Your subscription is ready to use.'
                    : provider.connectDescription
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
                      onClick: () => postMessage(provider.commands.signOut),
                    })
                  : renderLabeledActionButton({
                      icon: 'right-to-bracket',
                      text: provider.signInText,
                      kind: 'primary',
                      appearance: 'filled',
                      onClick: () => postMessage(provider.commands.signIn),
                    })
              }
            </div>
          </div>
          <subscription-usage-row
            .snapshot=${this.usage}
          ></subscription-usage-row>
        </div>
      </section>
    `;
  }
}

/**
 * Experimental "Sign in with ChatGPT". After sign-in, the configured
 * Codex-eligible models run on the user's ChatGPT subscription (when
 * `chatgptCodex.preferSubscription` is enabled) instead of an API key.
 */
export const CHATGPT_SUBSCRIPTION_SECTION: SubscriptionSectionProvider =
  Object.freeze({
    sectionId: 'chatgpt-subscription',
    title: 'ChatGPT subscription',
    description:
      'Use OpenAI models through your ChatGPT Plus, Pro, or Team subscription. No OpenAI API key is needed.',
    note: 'The subscription currently uses a 272,000-token Codex context cap, not the full 1,000,000-token API context.',
    preferLabel: 'Prefer ChatGPT subscription',
    preferDescription: 'Use the subscription for eligible Codex models.',
    accountTitle: 'ChatGPT account',
    connectDescription:
      'Connect the ChatGPT account that owns your subscription.',
    signInText: 'Sign in with ChatGPT',
    commands: Object.freeze({
      setPreferSubscription:
        SETTINGS_VIEW_COMMANDS.SET_CHATGPT_PREFER_SUBSCRIPTION,
      signIn: SETTINGS_VIEW_COMMANDS.SIGN_IN_CHATGPT,
      signOut: SETTINGS_VIEW_COMMANDS.SIGN_OUT_CHATGPT,
    }),
    accountLabel: codexAccountLabel,
  });

/**
 * Experimental "Sign in with Grok". After sign-in, xAI models can run on the
 * user's SuperGrok / xAI account OAuth token when `xaiGrok.preferSubscription`
 * is enabled.
 */
export const GROK_SUBSCRIPTION_SECTION: SubscriptionSectionProvider =
  Object.freeze({
    sectionId: 'grok-subscription',
    title: 'Grok subscription',
    description:
      'Use xAI Grok models through your SuperGrok / xAI account. No xAI API key is needed.',
    note: 'Uses the public Grok CLI OAuth client. xAI may change or revoke that registration without notice.',
    preferLabel: 'Prefer Grok subscription',
    preferDescription: 'Use the subscription instead of an xAI API key.',
    accountTitle: 'Grok account',
    connectDescription:
      'Connect the xAI account that owns your SuperGrok plan.',
    signInText: 'Sign in with Grok',
    commands: Object.freeze({
      setPreferSubscription:
        SETTINGS_VIEW_COMMANDS.SET_GROK_PREFER_SUBSCRIPTION,
      signIn: SETTINGS_VIEW_COMMANDS.SIGN_IN_GROK,
      signOut: SETTINGS_VIEW_COMMANDS.SIGN_OUT_GROK,
    }),
    accountLabel: xaiAccountLabel,
  });

declare global {
  interface HTMLElementTagNameMap {
    'subscription-section': SubscriptionSection;
  }
}
