/**
 * Subscription sign-in on the Models page: ChatGPT, Grok, and Copilot in VS
 * Code. Kimi Code and GLM Coding Plan are API keys, so they live on their
 * provider rows above, with their usage meters.
 */

import {
  LitElement,
  html,
  nothing,
  css,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles, schemas, and templates
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import {
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING,
  type SubscriptionUsageSnapshots,
} from '@shared/schemas';
import {
  type CopilotRouteInfo,
  type SubscriptionAuthStatuses,
} from '@shared/settingsView/settingsViewMessages';
import { TickerController } from '@shared/litControllers/TickerController';
import { commonViewStyles, designTokens } from '@ui/styles';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { renderSettingsSectionHeading } from '@ui/wa/settingsSection';
import { waIcon } from '@ui/wa/webAwesomeIcons';

// Side-effect imports - register WA button, details, icon, and tag components
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

  /** Parent-owned acknowledgement generation for restoring rejected edits. */
  @property({ attribute: false }) ackGeneration = 0;
  @property({ attribute: false }) subscriptionAuth: SubscriptionAuthStatuses =
    {};
  @property({ attribute: false }) chatgptCodexContextWindow =
    CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.defaultValue;
  @property({ attribute: false }) usage: SubscriptionUsageSnapshots | null =
    null;
  @property({ attribute: false }) copilotModels: CopilotRouteInfo[] = [];

  private readonly _ticker = new TickerController(this, 60_000);

  override connectedCallback(): void {
    super.connectedCallback();
    postMessage(SETTINGS_VIEW_COMMANDS.GET_SUBSCRIPTION_USAGE, {
      forceRefresh: false,
    });
  }

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has('usage')) this._ticker.refresh();
  }

  override render(): TemplateResult {
    return html`
      <div class="subscriptions-container">
        ${renderSettingsSectionHeading({
          title: 'Subscriptions',
          description:
            'Use a ChatGPT or Grok plan, or Copilot in VS Code, instead of an API key. Usage refreshes when this page opens.',
          icon: 'gem',
          actions: renderLabeledActionButton({
            icon: 'arrows-rotate',
            text: 'Refresh usage',
            kind: 'secondary',
            appearance: 'outlined',
            onClick: () =>
              postMessage(SETTINGS_VIEW_COMMANDS.GET_SUBSCRIPTION_USAGE, {
                forceRefresh: true,
              }),
          }),
        })}
        <subscription-section
          .ackGeneration=${this.ackGeneration}
          .provider=${CHATGPT_SUBSCRIPTION_SECTION}
          .auth=${this.subscriptionAuth.chatgpt ?? null}
          .contextWindow=${this.chatgptCodexContextWindow}
          .usage=${this.usage?.chatgpt ?? null}
          .now=${this._ticker.now}
        ></subscription-section>
        <subscription-section
          .provider=${GROK_SUBSCRIPTION_SECTION}
          .auth=${this.subscriptionAuth.grok ?? null}
          .now=${this._ticker.now}
        ></subscription-section>
        ${this.renderCopilotSection()}
      </div>
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
