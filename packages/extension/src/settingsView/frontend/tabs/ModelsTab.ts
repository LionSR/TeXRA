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
  KimiCodeAuthStatus,
  ModelSelectionItem,
  NumberVscodeSetting,
  ProviderKeyStatus,
} from '@shared/schemas/settingsViewMessages';
import type { SpendingStatus } from '@shared/schemas/spendingStatus';
import {
  CHATGPT_TOOL_USE_ONLY_DESCRIPTION,
  KIMI_CODE_TOOL_USE_ONLY_DESCRIPTION,
} from '@shared/schemas/coreSettings';

// Local imports - utilities
import { pluralize } from '@utils/text/stringUtils';

// Local imports - settings view components (side-effect: register)
import '../components/profile/ApiAccessSection';
import '../components/profile/RelayQuotaMeter';
import '../components/profile/ProviderKeyList';
import '../components/profile/ModelSelectionList';
import '../components/profile/ReliabilitySettingsSection';
import {
  ChatGptAuthEvents,
  KimiCodeAuthEvents,
  ModelSelectionEvents,
} from '../components/profile/events';
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

      .keyless-source {
        margin-top: var(--wa-space-l, 1rem);
        padding-top: var(--wa-space-m, 0.75rem);
        border-top: 1px solid var(--wa-color-surface-border);
      }
      .keyless-source__header {
        display: flex;
        align-items: center;
        gap: var(--wa-space-xs);
      }
      .keyless-source__title {
        font-weight: var(--font-weight-semibold);
      }
      .keyless-source__badge {
        font-size: var(--font-size-xs);
        text-transform: uppercase;
        letter-spacing: 0;
        opacity: 0.65;
        border: 1px solid currentColor;
        border-radius: var(--border-radius-small);
        padding: 0 0.4em;
      }
      .keyless-source__hint {
        margin: var(--wa-space-2xs) 0 var(--wa-space-xs);
        opacity: 0.8;
        font-size: var(--font-size-sm);
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
      .keyless-source__row {
        display: flex;
        align-items: center;
        gap: var(--wa-space-s);
        flex-wrap: wrap;
      }
      .keyless-source__setting {
        margin-bottom: var(--wa-space-xs);
      }
      .keyless-source__account {
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
  @property({ attribute: false }) kimiCodeAuth: KimiCodeAuthStatus | null =
    null;
  @property({ attribute: false }) globalStreamingDefault = true;
  @property({ attribute: false }) modelSelectionItems: ModelSelectionItem[] =
    [];
  @property({ attribute: false }) reliabilitySettings: NumberVscodeSetting[] =
    [];
  @property({ attribute: false }) helperModel = '';
  @property({ type: Boolean }) preferShortModelNames = false;

  private scrollToSection(
    selector:
      | 'api-access-section'
      | 'provider-key-list'
      | '#chatgpt-subscription'
      | '#copilot-access',
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

  private readonly handleKimiCodePreferSubscriptionChange = (
    event: Event,
  ): void => {
    const enabled = (event.target as WaSwitch).checked;
    this.dispatchEvent(KimiCodeAuthEvents.setPreferSubscription({ enabled }));
  };

  private readonly handleKimiCodeSubscriptionToolUseOnlyChange = (
    event: Event,
  ): void => {
    const enabled = (event.target as WaSwitch).checked;
    this.dispatchEvent(
      KimiCodeAuthEvents.setSubscriptionToolUseOnly({ enabled }),
    );
  };

  private renderTabHint(): TemplateResult {
    const copilotAvailable = this.modelSelectionItems.some(
      (model) => model.provider === 'copilot',
    );
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
            ${
              copilotAvailable
                ? html`<wa-button
                    appearance="outlined"
                    variant="neutral"
                    size="s"
                    @click=${() => this.scrollToSection('#copilot-access')}
                  >
                    ${waIcon('shield', { slot: 'start' })} Copilot in VS Code
                  </wa-button>`
                : nothing
            }
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
        ${this.renderChatGptSection()} ${this.renderKimiCodeSection()}
        ${this.renderCopilotSection()}
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
      <section id="chatgpt-subscription" class="keyless-source">
        <div class="keyless-source__header">
          <span class="keyless-source__title">ChatGPT subscription</span>
          <span class="keyless-source__badge">experimental</span>
        </div>
        <p class="keyless-source__hint">
          Use OpenAI models through your ChatGPT Plus, Pro, or Team
          subscription. No OpenAI API key is needed.
        </p>
        <p class="keyless-source__limit">
          ${waIcon('circle-info')}
          <span>
            Subscription routing currently uses a 272,000-token Codex context
            cap, not the full 1,000,000-token API context.
          </span>
        </p>
        <div class="keyless-source__setting">
          <wa-switch
            ?checked=${preferSubscription}
            @change=${this.handlePreferSubscriptionChange}
          >
            Prefer ChatGPT subscription
          </wa-switch>
        </div>
        <div class="keyless-source__setting">
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
            ? html`<div class="keyless-source__row">
                <span class="keyless-source__account">
                  ${waIcon('circle-check')} Signed in as ${account}
                </span>
                <wa-button
                  appearance="outlined"
                  size="s"
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

  /**
   * Experimental "Sign in with Kimi Code" control. After sign-in, Kimi models
   * run on the user's Moonshot coding subscription (when
   * `kimiCode.preferSubscription` is enabled) instead of an API key.
   */
  private renderKimiCodeSection(): TemplateResult {
    const signedIn = this.kimiCodeAuth?.signedIn ?? false;
    const preferSubscription = this.kimiCodeAuth?.preferSubscription ?? false;
    const subscriptionToolUseOnly =
      this.kimiCodeAuth?.subscriptionToolUseOnly ?? false;
    const account = this.kimiCodeAuth?.accountId ?? 'your account';
    return html`
      <section id="kimi-code-subscription" class="keyless-source">
        <div class="keyless-source__header">
          <span class="keyless-source__title">Kimi Code subscription</span>
          <span class="keyless-source__badge">experimental</span>
        </div>
        <p class="keyless-source__hint">
          Use Kimi models through your Kimi Code coding subscription. No API
          key is needed.
        </p>
        <p class="keyless-source__limit">
          ${waIcon('circle-info')}
          <span>
            A
            <a href="https://www.kimi.com/code/console">
              Kimi Code console API key
            </a>
            works as an alternative — set it on the Kimi Code row under API
            Configuration below.
          </span>
        </p>
        <div class="keyless-source__setting">
          <wa-switch
            ?checked=${preferSubscription}
            @change=${this.handleKimiCodePreferSubscriptionChange}
          >
            Prefer Kimi Code subscription
          </wa-switch>
        </div>
        <div class="keyless-source__setting">
          <wa-switch
            ?checked=${subscriptionToolUseOnly}
            ?disabled=${!preferSubscription}
            hint=${KIMI_CODE_TOOL_USE_ONLY_DESCRIPTION}
            @change=${this.handleKimiCodeSubscriptionToolUseOnlyChange}
          >
            Use subscription for tool-use agents only
          </wa-switch>
        </div>
        ${
          signedIn
            ? html`<div class="keyless-source__row">
                <span class="keyless-source__account">
                  ${waIcon('circle-check')} Signed in as ${account}
                </span>
                <wa-button
                  appearance="outlined"
                  size="s"
                  @click=${() =>
                    this.dispatchEvent(KimiCodeAuthEvents.signOut())}
                >
                  Sign out
                </wa-button>
              </div>`
            : html`<wa-button
                variant="brand"
                size="small"
                @click=${() => this.dispatchEvent(KimiCodeAuthEvents.signIn())}
              >
                Sign in with Kimi Code
              </wa-button>`
        }
      </section>
    `;
  }

  private renderCopilotSection(): TemplateResult | typeof nothing {
    const models = this.modelSelectionItems.filter(
      (model) => model.provider === 'copilot',
    );
    if (models.length === 0) return nothing;

    const readyCount = models.filter(
      (model) => model.availability === 'copilot-access',
    ).length;
    const consentModel = models.find(
      (model) => model.availability === 'copilot-consent-required',
    );
    const unavailableCount = models.filter(
      (model) => model.availability === 'copilot-unavailable',
    ).length;
    let status: string;
    if (consentModel) {
      status = 'VS Code is ready to ask for your consent.';
    } else if (readyCount > 0) {
      status = `${readyCount} ${pluralize(readyCount, 'Copilot model is', 'Copilot models are')} ready.`;
    } else {
      status = `${unavailableCount} ${pluralize(unavailableCount, 'Copilot model is', 'Copilot models are')} unavailable.`;
    }

    return html`
      <section id="copilot-access" class="keyless-source">
        <div class="keyless-source__header">
          <span class="keyless-source__title">Copilot in VS Code</span>
          <span class="keyless-source__badge">keyless</span>
        </div>
        <p class="keyless-source__hint">
          Use models supplied by your GitHub Copilot subscription. No provider
          API key is needed.
        </p>
        <div class="keyless-source__row">
          <span class="keyless-source__account">
            ${waIcon(readyCount > 0 ? 'circle-check' : 'circle-info')} ${status}
          </span>
          ${
            consentModel
              ? html`<wa-button
                  variant="brand"
                  size="s"
                  @click=${() =>
                    this.dispatchEvent(
                      ModelSelectionEvents.requestAccess({
                        modelName: consentModel.name,
                      }),
                    )}
                >
                  ${waIcon('shield', { slot: 'start' })} Grant access
                </wa-button>`
              : nothing
          }
        </div>
        ${
          unavailableCount > 0 && !consentModel
            ? html`<p class="keyless-source__limit">
                ${waIcon('warning')}
                <span>
                  Check Copilot availability and Language Models access in VS
                  Code before trying again.
                </span>
              </p>`
            : nothing
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
