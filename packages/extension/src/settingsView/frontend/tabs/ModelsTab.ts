/** API access, provider keys, and model selection for the settings view. */

import { LitElement, html, nothing, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

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
import '@awesome.me/webawesome/dist/components/tag/tag.js';

// Local imports - shared schemas
import type {
  CopilotRouteInfo,
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
  @property({ attribute: false }) globalStreamingDefault = true;
  @property({ attribute: false }) modelSelectionItems: ModelSelectionItem[] =
    [];
  @property({ attribute: false }) copilotModels: CopilotRouteInfo[] = [];
  @property({ attribute: false }) reliabilitySettings: NumberSetting[] = [];
  @property({ attribute: false }) helperModel = '';
  @property({ type: Boolean }) preferShortModelNames = false;

  override render(): TemplateResult {
    const apiAccessSection = this.authenticated
      ? html`<api-access-section
          .mode=${this.apiAccessMode}
        ></api-access-section>`
      : nothing;

    return html`
      <div class="models-container tab-content-container">
        ${apiAccessSection} ${this.renderCopilotSection()}
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
      status = `${blockedPreferredCount} selected ${pluralize(blockedPreferredCount, 'Copilot route needs', 'Copilot routes need')} attention.`;
    } else if (consentCount > 0) {
      status = 'VS Code is ready to ask for your consent.';
    } else if (readyCount > 0) {
      status = `${readyCount} ${pluralize(readyCount, 'Copilot model is', 'Copilot models are')} ready.`;
    } else {
      status = `${unavailableCount} ${pluralize(unavailableCount, 'Copilot model is', 'Copilot models are')} unavailable.`;
    }

    // Each route gets its own responsive settings row. Short action labels
    // keep controls usable in narrow panels while the adjacent text names the
    // model and route state.
    const actionRows = models.flatMap((model) => {
      let routeStatus: string;
      let action: TemplateResult;
      if (model.preferred) {
        if (model.access === 'allowed') {
          routeStatus = 'Copilot route selected.';
        } else if (model.access === 'consent-required') {
          routeStatus =
            'Selected Copilot route is waiting for VS Code consent.';
        } else {
          routeStatus = 'Selected Copilot route is currently unavailable.';
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
            ? html`${renderLabeledActionButton({
                icon: 'shield',
                text: 'Grant access',
                kind: 'primary',
                appearance: 'filled',
                onClick: () =>
                  postMessage(SETTINGS_VIEW_COMMANDS.REQUEST_MODEL_ACCESS, {
                    modelName: model.name,
                  }),
              })}${stopAction}`
            : stopAction;
      } else if (model.access === 'consent-required') {
        routeStatus = 'VS Code consent is required.';
        action = renderLabeledActionButton({
          icon: 'shield',
          text: 'Grant access',
          kind: 'primary',
          appearance: 'filled',
          onClick: () =>
            postMessage(SETTINGS_VIEW_COMMANDS.REQUEST_MODEL_ACCESS, {
              modelName: model.name,
            }),
        });
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
          </div>
          ${actionRows}
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
    'models-tab': ModelsTab;
  }
}
