/** Subscription-backed model access: ChatGPT, Copilot in VS Code, Kimi Code. */

import {
  LitElement,
  html,
  nothing,
  css,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import {
  SETTINGS_TAB,
  type ChatGptAuthStatus,
  type CopilotRouteInfo,
  type GrokAuthStatus,
  type SubscriptionUsageProvider,
  type SubscriptionUsageSnapshots,
} from '@shared/schemas';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { renderSettingsSectionHeading } from '@shared/wa/settingsSection';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Web Awesome icon bundle (side-effect import)
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';

// Local imports - utilities
import { pluralize } from '@utils/text/stringUtils';

// Local imports - settings view components (importing the descriptors also
// registers the <subscription-section> element)
import {
  CHATGPT_SUBSCRIPTION_SECTION,
  GROK_SUBSCRIPTION_SECTION,
} from '../components/profile/SubscriptionSection';
import '../components/profile/SubscriptionUsageRow';

const KIMI_CODE_CONSOLE_URL = 'https://www.kimi.com/code/console';
const GLM_CODING_PLAN_CONSOLE_URL = 'https://z.ai/subscribe';

/** One API-key-based coding-plan subscription section (GLM Coding Plan, Kimi
 *  Code). Both share the same three-step setup: get a key, add it, enable the
 *  plan toggle. */
interface CodingPlanSection {
  readonly sectionId: string;
  readonly title: string;
  readonly description: string;
  readonly consoleUrl: string;
  readonly keyLabel: string;
  readonly keyHelp: string;
  readonly toggleLabel: string;
  readonly toggleHelp: string;
  readonly usageProvider: Extract<
    SubscriptionUsageProvider,
    'kimiCode' | 'glmCodingPlan'
  >;
}

const CODING_PLAN_SECTIONS: readonly CodingPlanSection[] = [
  {
    sectionId: 'glm-coding-plan-subscription',
    title: 'GLM Coding Plan',
    description:
      'Use a GLM Coding Plan subscription for GLM models via the coding endpoint.',
    consoleUrl: GLM_CODING_PLAN_CONSOLE_URL,
    keyLabel: '1. Get a subscription key',
    keyHelp: 'Subscribe and create an API key in the Z.AI console.',
    toggleLabel: '3. Enable the Coding Plan',
    toggleHelp:
      'Turn on "GLM Coding Plan" on the GLM row so requests route through the coding endpoint with your plan\u2019s monthly quota.',
    usageProvider: 'glmCodingPlan',
  },
  {
    sectionId: 'kimi-code-subscription',
    title: 'Kimi Code',
    description: 'Use a Kimi Code membership for the kimi-for-coding models.',
    consoleUrl: KIMI_CODE_CONSOLE_URL,
    keyLabel: '1. Get a membership key',
    keyHelp: 'Create an API key in the Kimi Code console.',
    toggleLabel: '3. Optional: prefer Kimi Code',
    toggleHelp:
      'Enable "Prefer Kimi Code" on the same row so K3 also uses your Kimi Code subscription; the kimi-for-coding models always do.',
    usageProvider: 'kimiCode',
  },
];

@customElement('subscriptions-tab')
export class SubscriptionsTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      /* max-width and centering provided by .tab-content-container */

      .copilot-route-controls {
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      @container settings (max-width: 520px) {
        .copilot-route-controls {
          align-self: stretch;
          justify-content: flex-start;
        }
      }
    `,
  ];

  @property({ attribute: false }) chatgptAuth: ChatGptAuthStatus | null = null;
  @property({ attribute: false }) grokAuth: GrokAuthStatus | null = null;
  @property({ attribute: false }) usage: SubscriptionUsageSnapshots | null =
    null;
  @property({ attribute: false }) copilotModels: CopilotRouteInfo[] = [];
  @state() private now = 0;

  private clock: ReturnType<typeof setInterval> | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this.refreshNow();
    this.clock = setInterval(() => this.refreshNow(), 60_000);
    postMessage(SETTINGS_VIEW_COMMANDS.GET_SUBSCRIPTION_USAGE, {
      forceRefresh: false,
    });
  }

  override disconnectedCallback(): void {
    if (this.clock !== undefined) clearInterval(this.clock);
    this.clock = undefined;
    super.disconnectedCallback();
  }

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has('usage')) this.refreshNow();
  }

  private refreshNow(): void {
    this.now = Date.now();
  }

  override render(): TemplateResult {
    return html`
      <div class="subscriptions-container tab-content-container">
        <div class="settings-section">
          <div class="settings-row">
            <div class="settings-row-text">
              <span class="settings-row-label">Subscription usage</span>
              <span class="settings-row-help">
                Cached briefly and refreshed only when this tab opens or you
                ask.
              </span>
            </div>
            <div class="settings-row-control">
              ${renderLabeledActionButton({
                icon: 'arrows-rotate',
                text: 'Refresh usage',
                kind: 'secondary',
                appearance: 'outlined',
                onClick: () =>
                  postMessage(SETTINGS_VIEW_COMMANDS.GET_SUBSCRIPTION_USAGE, {
                    forceRefresh: true,
                  }),
              })}
            </div>
          </div>
        </div>
        <subscription-section
          .provider=${CHATGPT_SUBSCRIPTION_SECTION}
          .auth=${this.chatgptAuth}
          .usage=${this.usage?.chatgpt ?? null}
          .now=${this.now}
        ></subscription-section>
        <subscription-section
          .provider=${GROK_SUBSCRIPTION_SECTION}
          .auth=${this.grokAuth}
          .usage=${this.usage?.grok ?? null}
          .now=${this.now}
        ></subscription-section>
        ${CODING_PLAN_SECTIONS.map((section) =>
          this.renderCodingPlanSection(section),
        )}
        ${this.renderCopilotSection()}
      </div>
    `;
  }

  private renderCodingPlanSection(section: CodingPlanSection): TemplateResult {
    return html`
      <section id=${section.sectionId}>
        ${renderSettingsSectionHeading({
          title: section.title,
          description: section.description,
          icon: 'gem',
        })}
        <div class="settings-section">
          <div class="settings-row">
            <div class="settings-row-text">
              <span class="settings-row-label">${section.keyLabel}</span>
              <span class="settings-row-help">${section.keyHelp}</span>
            </div>
            <div class="settings-row-control">
              ${renderLabeledActionButton({
                icon: 'arrow-up-right-from-square',
                text: 'Open console',
                kind: 'secondary',
                appearance: 'outlined',
                onClick: () =>
                  postMessage(SETTINGS_VIEW_COMMANDS.OPEN_EXTERNAL_URL, {
                    url: section.consoleUrl,
                  }),
              })}
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-text">
              <span class="settings-row-label">2. Add the key</span>
              <span class="settings-row-help">
                Paste it on the ${section.title} row in Providers &amp; Models,
                or set the provider API key environment variable.
              </span>
            </div>
            <div class="settings-row-control">
              ${renderLabeledActionButton({
                icon: 'server',
                text: 'Open Providers & Models',
                kind: 'secondary',
                appearance: 'outlined',
                onClick: () =>
                  postMessage(SETTINGS_VIEW_COMMANDS.SET_TAB, {
                    tabIndex: SETTINGS_TAB.MODELS,
                  }),
              })}
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-text">
              <span class="settings-row-label">${section.toggleLabel}</span>
              <span class="settings-row-help">${section.toggleHelp}</span>
            </div>
          </div>
          <subscription-usage-row
            .snapshot=${this.usage?.[section.usageProvider] ?? null}
            .now=${this.now}
          ></subscription-usage-row>
        </div>
      </section>
    `;
  }

  private renderCopilotSection(): TemplateResult | typeof nothing {
    const models = this.copilotModels;
    if (models.length === 0) return nothing;

    const readyCount = models.filter(
      (model) => model.access === 'allowed',
    ).length;
    const consentCount = models.filter(
      (model) => model.access === 'consent-required' && !model.preferred,
    ).length;
    const blockedPreferredCount = models.filter(
      (model) => model.preferred && model.access !== 'allowed',
    ).length;
    const unavailableCount = models.filter(
      (model) => model.access === 'unavailable',
    ).length;
    let status: string;
    if (blockedPreferredCount > 0) {
      status = `${blockedPreferredCount} selected ${pluralize(blockedPreferredCount, 'Copilot model needs', 'Copilot models need')} attention.`;
    } else if (consentCount > 0) {
      status = 'VS Code is ready to ask for your approval.';
    } else if (readyCount > 0) {
      status = `${readyCount} ${pluralize(readyCount, 'Copilot model is', 'Copilot models are')} ready.`;
    } else {
      status = `${unavailableCount} ${pluralize(unavailableCount, 'Copilot model is', 'Copilot models are')} unavailable.`;
    }

    // Each model gets its own responsive settings row. Short action labels
    // keep controls usable in narrow panels while the adjacent text names the
    // model and its state.
    const renderGrantAccess = (model: CopilotRouteInfo): TemplateResult =>
      renderLabeledActionButton({
        icon: 'shield',
        text: 'Grant access',
        kind: 'primary',
        appearance: 'filled',
        onClick: () =>
          postMessage(SETTINGS_VIEW_COMMANDS.REQUEST_MODEL_ACCESS, {
            modelName: model.name,
          }),
      });

    const actionRows = models.flatMap((model) => {
      let routeStatus: string;
      let action: TemplateResult;
      if (model.preferred) {
        if (model.access === 'allowed') {
          routeStatus = 'Using Copilot for this model.';
        } else if (model.access === 'consent-required') {
          routeStatus = 'Selected. Waiting for your approval in VS Code.';
        } else {
          routeStatus = 'Selected, but currently unavailable.';
        }
        const stopAction = renderLabeledActionButton({
          icon: 'xmark',
          text: 'Stop using Copilot',
          kind: 'secondary',
          appearance: 'outlined',
          onClick: () =>
            postMessage(SETTINGS_VIEW_COMMANDS.CLEAR_COPILOT_ROUTE, {
              modelName: model.name,
            }),
        });
        action =
          model.access === 'consent-required'
            ? html`${renderGrantAccess(model)}${stopAction}`
            : stopAction;
      } else if (model.access === 'consent-required') {
        routeStatus = 'Needs your approval in VS Code.';
        action = renderGrantAccess(model);
      } else if (model.access === 'allowed') {
        routeStatus = 'Ready to use through Copilot.';
        action = renderLabeledActionButton({
          icon: 'shield',
          text: 'Use Copilot',
          kind: 'secondary',
          appearance: 'outlined',
          onClick: () =>
            postMessage(SETTINGS_VIEW_COMMANDS.REQUEST_MODEL_ACCESS, {
              modelName: model.name,
            }),
        });
      } else {
        return [];
      }
      return [
        html`<div class="settings-row copilot-route-action">
          <div class="settings-row-text">
            <span class="settings-row-label">${model.label}</span>
            <span class="settings-row-help">${routeStatus}</span>
          </div>
          <div class="settings-row-control copilot-route-controls">
            ${action}
          </div>
        </div>`,
      ];
    });

    // Keep the per-model controls collapsed behind the status summary unless
    // something needs a decision: a pending approval, a blocked model, or an
    // active model whose "Stop using Copilot" control must stay visible.
    const showRoutes =
      blockedPreferredCount > 0 ||
      consentCount > 0 ||
      models.some((model) => model.preferred);

    return html`
      <section id="copilot-access">
        ${renderSettingsSectionHeading({
          title: 'Copilot in VS Code',
          description:
            'Use models supplied by your GitHub Copilot subscription. No provider API key is needed.',
          icon: 'cloud',
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
          </div>
          ${
            actionRows.length > 0
              ? html`<wa-details
                  class="panel-collapsible"
                  summary="Manage Copilot models"
                  ?open=${showRoutes}
                >
                  ${actionRows}
                </wa-details>`
              : nothing
          }
        </div>
        ${
          unavailableCount > 0 && consentCount === 0
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
    'subscriptions-tab': SubscriptionsTab;
  }
}
