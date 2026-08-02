/** API access, provider keys, and model selection for the settings view. */

import { LitElement, html, nothing, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared auth
import { codexAccountLabel } from '@auth/codex/codexSessionTypes';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { renderSettingsSectionHeading } from '@shared/wa/settingsSection';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Web Awesome icon bundle (side-effect import)
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';

// Local imports - shared schemas
import type {
  ChatGptAuthStatus,
  ModelSelectionItem,
  NumberSetting,
  ProviderKeyStatus,
} from '@shared/schemas/settingsViewMessages';

// Local imports - utilities
import { pluralize } from '@utils/text/stringUtils';

// Local imports - settings view components (side-effect: register)
import '../components/profile/ApiAccessSection';
import '../components/profile/ProviderKeyList';
import '../components/profile/ModelSelectionList';
import '../components/profile/ReliabilitySettingsSection';
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

  @property({ attribute: false }) authenticated = false;
  @property({ attribute: false }) apiAccessMode: 'included' | 'personal' =
    'personal';
  @property({ attribute: false }) providerKeyStatuses: ProviderKeyStatus[] = [];
  @property({ attribute: false }) chatgptAuth: ChatGptAuthStatus | null = null;
  @property({ attribute: false }) globalStreamingDefault = true;
  @property({ attribute: false }) modelSelectionItems: ModelSelectionItem[] =
    [];
  @property({ attribute: false }) reliabilitySettings: NumberSetting[] = [];
  @property({ attribute: false }) helperModel = '';
  @property({ type: Boolean }) preferShortModelNames = false;

  private readonly handlePreferSubscriptionChange = (event: Event): void => {
    const enabled = (event.target as WaSwitch).checked;
    postMessage(SETTINGS_VIEW_COMMANDS.SET_CHATGPT_PREFER_SUBSCRIPTION, {
      enabled,
    });
  };

  override render(): TemplateResult {
    const apiAccessSection = this.authenticated
      ? html`<api-access-section
          .mode=${this.apiAccessMode}
        ></api-access-section>`
      : nothing;

    return html`
      <div class="models-container tab-content-container">
        ${apiAccessSection} ${this.renderChatGptSection()}
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
      <section id="copilot-access">
        ${renderSettingsSectionHeading({
          title: 'Copilot in VS Code',
          description:
            'Use models supplied by your GitHub Copilot subscription. No provider API key is needed.',
          actions: html`<wa-tag variant="neutral" size="s">Keyless</wa-tag>`,
        })}
        <div class="settings-section">
          <div class="settings-row">
            <div class="settings-row-text">
              <span class="settings-row-label">
                ${waIcon(readyCount > 0 ? 'circle-check' : 'circle-info')}
                ${status}
              </span>
              <span class="settings-row-help">
                Access is managed by VS Code and GitHub Copilot.
              </span>
            </div>
            <div class="settings-row-control">
              ${
                consentModel
                  ? renderLabeledActionButton({
                      icon: 'shield',
                      text: 'Grant access',
                      kind: 'primary',
                      appearance: 'filled',
                      onClick: () =>
                        postMessage(
                          SETTINGS_VIEW_COMMANDS.REQUEST_MODEL_ACCESS,
                          {
                            modelName: consentModel.name,
                          },
                        ),
                    })
                  : nothing
              }
            </div>
          </div>
        </div>
        ${
          unavailableCount > 0 && !consentModel
            ? html`<p class="keyless-source__limit">
                ${waIcon('triangle-exclamation')}
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
