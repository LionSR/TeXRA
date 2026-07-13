/** API access, provider keys, and model selection for the settings view. */

import { LitElement, html, nothing, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Web Awesome icon bundle (side-effect import)
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';

// Local imports - shared schemas
import type {
  ChatGptAuthStatus,
  ModelSelectionItem,
  NumberVscodeSetting,
  ProviderKeyStatus,
} from '@shared/schemas/settingsViewMessages';
import type { SpendingStatus } from '@shared/schemas/spendingStatus';
import { CHATGPT_TOOL_USE_ONLY_DESCRIPTION } from '@shared/schemas/coreSettings';

// Local imports - settings view components (side-effect: register)
import '../components/profile/ApiAccessSection';
import '../components/profile/RelayQuotaMeter';
import '../components/profile/ProviderKeyList';
import '../components/profile/ModelSelectionList';
import '../components/profile/ReliabilitySettingsSection';
import { ChatGptAuthEvents } from '../components/profile/events';
import type WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';

@customElement('models-tab')
export class ModelsTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      /* max-width and centering provided by .tab-content-container */

      .chatgpt-subscription {
        margin-top: var(--wa-space-l, 1rem);
        padding-top: var(--wa-space-m, 0.75rem);
        border-top: 1px solid var(--wa-color-surface-border);
      }
      .chatgpt-subscription__header {
        display: flex;
        align-items: center;
        gap: var(--wa-space-xs);
      }
      .chatgpt-subscription__title {
        font-weight: var(--font-weight-semibold);
      }
      .chatgpt-subscription__badge {
        font-size: var(--font-size-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        opacity: 0.65;
        border: 1px solid currentColor;
        border-radius: var(--border-radius-small);
        padding: 0 0.4em;
      }
      .chatgpt-subscription__hint {
        margin: var(--wa-space-2xs) 0 var(--wa-space-xs);
        opacity: 0.8;
        font-size: var(--font-size-sm);
      }
      .chatgpt-subscription__limit {
        display: flex;
        align-items: flex-start;
        gap: var(--wa-space-xs);
        margin: 0 0 var(--wa-space-xs);
        opacity: 0.85;
        font-size: var(--font-size-sm);
      }
      .chatgpt-subscription__limit wa-icon {
        flex: 0 0 auto;
        margin-top: var(--wa-space-3xs);
      }
      .chatgpt-subscription__row {
        display: flex;
        align-items: center;
        gap: var(--wa-space-s);
        flex-wrap: wrap;
      }
      .chatgpt-subscription__setting {
        margin-bottom: var(--wa-space-xs);
      }
      .chatgpt-subscription__account {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-2xs);
      }
    `,
  ];

  @property({ attribute: false }) authenticated = false;
  @property({ attribute: false }) apiAccessMode: 'included' | 'personal' =
    'personal';
  @property({ attribute: false }) spendingStatus: SpendingStatus | null = null;
  @property({ type: Boolean }) quotaAutoSwitched = false;
  @property({ attribute: false }) providerKeyStatuses: ProviderKeyStatus[] = [];
  @property({ attribute: false }) chatgptAuth: ChatGptAuthStatus | null = null;
  @property({ attribute: false }) globalStreamingDefault = true;
  @property({ attribute: false }) modelSelectionItems: ModelSelectionItem[] =
    [];
  @property({ attribute: false }) reliabilitySettings: NumberVscodeSetting[] =
    [];
  @property({ attribute: false }) helperModel = '';
  @property({ type: Boolean }) preferShortModelNames = false;

  private scrollToSection(
    selector:
      'api-access-section' | 'provider-key-list' | '#chatgpt-subscription',
  ): void {
    const el = this.shadowRoot?.querySelector(selector);
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  private readonly handleScrollToApiAccess = (): void =>
    this.scrollToSection('api-access-section');

  private readonly handleScrollToApiConfig = (): void =>
    this.scrollToSection('provider-key-list');

  private readonly handleScrollToChatGpt = (): void =>
    this.scrollToSection('#chatgpt-subscription');

  private readonly handlePreferSubscriptionChange = (event: Event): void => {
    const enabled = (event.target as WaSwitch).checked;
    this.dispatchEvent(ChatGptAuthEvents.setPreferSubscription({ enabled }));
  };

  private readonly handleSubscriptionToolUseOnlyChange = (
    event: Event,
  ): void => {
    const enabled = (event.target as WaSwitch).checked;
    this.dispatchEvent(
      ChatGptAuthEvents.setSubscriptionToolUseOnly({ enabled }),
    );
  };

  private renderTabHint(): TemplateResult {
    const description =
      this.apiAccessMode === 'included'
        ? 'Use included access, ChatGPT subscription for Codex models, or personal provider API keys.'
        : 'Use ChatGPT subscription for Codex models, or configure personal API keys for OpenAI, Anthropic, Google, and other providers.';

    const accessJump = this.authenticated
      ? html`<wa-button
          appearance="outlined"
          variant="neutral"
          size="small"
          @click=${this.handleScrollToApiAccess}
        >
          Model Access
        </wa-button>`
      : nothing;

    return html`
      <div class="settings-reminder">
        ${waIcon('info', { className: 'settings-reminder-icon' })}
        <div class="settings-reminder-body">
          <div class="settings-reminder-title">Model credentials</div>
          <div class="settings-reminder-description">${description}</div>
          <div class="settings-reminder-actions">
            ${accessJump}
            <wa-button
              appearance="outlined"
              variant="neutral"
              size="small"
              @click=${this.handleScrollToChatGpt}
            >
              ${waIcon('comment-discussion', { slot: 'start' })} ChatGPT
              Subscription
            </wa-button>
            <wa-button
              appearance="outlined"
              variant="neutral"
              size="small"
              @click=${this.handleScrollToApiConfig}
            >
              ${waIcon('key', { slot: 'start' })} Jump to API Configuration
            </wa-button>
          </div>
        </div>
      </div>
    `;
  }

  override render(): TemplateResult {
    const apiAccessSection = this.authenticated
      ? html`<api-access-section
          .mode=${this.apiAccessMode}
        ></api-access-section>`
      : nothing;

    const quotaMeter =
      this.authenticated && this.spendingStatus
        ? html`<relay-quota-meter
            .status=${this.spendingStatus}
            .autoSwitched=${this.quotaAutoSwitched}
          ></relay-quota-meter>`
        : nothing;

    return html`
      <div class="models-container tab-content-container">
        ${this.renderTabHint()} ${apiAccessSection} ${quotaMeter}
        ${this.renderChatGptSection()}
        <provider-key-list
          .providerKeyStatuses=${this.providerKeyStatuses}
          .apiAccessMode=${this.apiAccessMode}
          .globalStreamingDefault=${this.globalStreamingDefault}
        ></provider-key-list>
        <model-selection-list
          .models=${this.modelSelectionItems}
          .helperModel=${this.helperModel}
          .providerKeyStatuses=${this.providerKeyStatuses}
          .preferShortModelNames=${this.preferShortModelNames}
        ></model-selection-list>
        <reliability-settings-section
          .settings=${this.reliabilitySettings}
        ></reliability-settings-section>
      </div>
    `;
  }

  /**
   * Experimental "Sign in with ChatGPT" control. After sign-in, the configured
   * Codex-eligible models run on the user's own ChatGPT subscription (when
   * `chatgptCodex.preferSubscription` is enabled) instead of an API key.
   */
  private renderChatGptSection(): TemplateResult {
    const signedIn = this.chatgptAuth?.signedIn ?? false;
    const preferSubscription = this.chatgptAuth?.preferSubscription ?? false;
    const subscriptionToolUseOnly =
      this.chatgptAuth?.subscriptionToolUseOnly ?? false;
    const account =
      this.chatgptAuth?.email ?? this.chatgptAuth?.accountId ?? 'your account';
    return html`
      <section id="chatgpt-subscription" class="chatgpt-subscription">
        <div class="chatgpt-subscription__header">
          <span class="chatgpt-subscription__title">ChatGPT subscription</span>
          <span class="chatgpt-subscription__badge">experimental</span>
        </div>
        <p class="chatgpt-subscription__hint">
          Use OpenAI models through your ChatGPT Plus, Pro, or Team
          subscription. No OpenAI API key is needed.
        </p>
        <p class="chatgpt-subscription__limit">
          ${waIcon('circle-info')}
          <span>
            Subscription routing currently uses a 272,000-token Codex context
            cap, not the full 1,000,000-token API context.
          </span>
        </p>
        <div class="chatgpt-subscription__setting">
          <wa-switch
            ?checked=${preferSubscription}
            @change=${this.handlePreferSubscriptionChange}
          >
            Prefer ChatGPT subscription
          </wa-switch>
        </div>
        <div class="chatgpt-subscription__setting">
          <wa-switch
            ?checked=${subscriptionToolUseOnly}
            ?disabled=${!preferSubscription}
            hint=${CHATGPT_TOOL_USE_ONLY_DESCRIPTION}
            @change=${this.handleSubscriptionToolUseOnlyChange}
          >
            Use subscription for tool-use agents only
          </wa-switch>
        </div>
        ${
          signedIn
            ? html`<div class="chatgpt-subscription__row">
                <span class="chatgpt-subscription__account">
                  ${waIcon('circle-check')} Signed in as ${account}
                </span>
                <wa-button
                  appearance="outlined"
                  size="small"
                  @click=${() => this.dispatchEvent(ChatGptAuthEvents.signOut())}
                >
                  Sign out
                </wa-button>
              </div>`
            : html`<wa-button
                variant="brand"
                size="small"
                @click=${() => this.dispatchEvent(ChatGptAuthEvents.signIn())}
              >
                Sign in with ChatGPT
              </wa-button>`
        }
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'models-tab': ModelsTab;
  }
}
