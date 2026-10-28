/** Provider API key statuses with set/remove/get-URL actions and per-provider settings. */

import {
  LitElement,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
// Local imports - shared styles
import { providerEndpointKey } from '@texra-ai/harness/schemas';
import type { SubscriptionUsageSnapshots } from '@texra/shared/model/subscriptionUsage';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import { postMessage } from '@texra/shared/hostBridge';
import { TickerController } from '@texra/shared/litControllers/TickerController';
import type {
  ProviderKeyStatus,
  ProviderSetting,
} from '@texra/shared/settingsView/profileViewMessages';
import { CODING_PLAN_BY_API_PROVIDER } from '@texra/shared/model/codingPlans';
import { ANTHROPIC_PLAN_CREDITS } from '@ui/copy/modelAccess';
import { commonViewStyles, designTokens } from '@ui/styles';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { renderIconActionButton } from '@ui/wa/actionButtons';
import { renderSettingsSectionHeading } from '@ui/wa/settingsSection';
import { renderKeyStatusIcon, statusCheckIconStyles } from '@ui/wa/statusIcons';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';

// Local imports - profile view styles and events
import { postStateSetting } from '../shared/stateSettingRows';
import { providerKeyListStyles } from './ProviderKeyList.styles';
import './SubscriptionUsageRow';
import type WaInput from '@awesome.me/webawesome/dist/components/input/input.js';
import type WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';

@customElement('provider-key-list')
export class ProviderKeyList extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    statusCheckIconStyles,
    providerKeyListStyles,
  ];

  /** Null until the profile state arrives. */
  @property({ attribute: false }) providerKeyStatuses:
    readonly ProviderKeyStatus[] | null = null;

  /** Plan usage for the coding-plan providers (Kimi Code, GLM Coding Plan). */
  @property({ attribute: false }) usage: SubscriptionUsageSnapshots | null =
    null;

  @state() private expandedProvider: string | null = null;

  private readonly ticker = new TickerController(this, 60_000);

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has('usage')) this.ticker.refresh();
  }

  private toggleExpanded(provider: string): void {
    this.expandedProvider =
      this.expandedProvider === provider ? null : provider;
  }

  private renderActions(entry: ProviderKeyStatus): TemplateResult {
    const { displayName, provider } = entry;
    const removeButton =
      entry.status === 'set'
        ? renderIconActionButton({
            id: `provider-key-remove-${provider}`,
            icon: 'trash',
            label: `Remove ${displayName} API key`,
            tooltip: 'Remove key',
            onClick: () =>
              postMessage(SETTINGS_VIEW_COMMANDS.REMOVE_PROVIDER_KEY, {
                provider,
              }),
          })
        : nothing;

    return html`
      <div class="provider-actions action-button-group">
        ${renderIconActionButton({
          id: `provider-key-set-${provider}`,
          icon: 'key',
          label: `Set ${displayName} API key`,
          tooltip: 'Set API key',
          onClick: () =>
            postMessage(SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY, { provider }),
        })}
        ${renderIconActionButton({
          id: `provider-key-get-${provider}`,
          icon: 'arrow-up-right-from-square',
          label: `Open ${displayName} API key page`,
          tooltip: 'Get API key from provider',
          onClick: () =>
            postMessage(SETTINGS_VIEW_COMMANDS.OPEN_PROVIDER_KEY_URL, {
              provider,
            }),
        })}
        ${removeButton}
      </div>
    `;
  }

  private renderDetails(entry: ProviderKeyStatus): TemplateResult {
    const endpointInput = entry.supportsCustomEndpoint
      ? html`
          <div class="provider-setting">
            <label for=${`endpoint-${entry.provider}`}>Custom endpoint</label>
            <wa-input
              id=${`endpoint-${entry.provider}`}
              class="endpoint-input form-control-fill"
              name=${`endpoint-${entry.provider}`}
              type="url"
              inputmode="url"
              autocomplete="url"
              spellcheck="false"
              dir="ltr"
              .value=${entry.customEndpoint}
              placeholder="Leave blank for default"
              @change=${(e: Event) => {
                const value = (e.target as WaInput).value?.trim() ?? '';
                const key = providerEndpointKey(entry.provider);
                if (key) postStateSetting(key, value);
              }}
            ></wa-input>
          </div>
        `
      : nothing;

    return html`
      <div class="settings-disclosure-content provider-settings">
        ${endpointInput}
        ${entry.providerSettings.map((s) => this.renderProviderSetting(s))}
        ${this.renderPlanUsage(entry.provider)}
      </div>
    `;
  }

  /** The plan's usage meter, on the provider row whose key the plan uses. */
  private renderPlanUsage(provider: string): TemplateResult | typeof nothing {
    const plan = CODING_PLAN_BY_API_PROVIDER.get(provider);
    if (!plan) return nothing;
    return html`<subscription-usage-row
      .snapshot=${this.usage?.[plan.usageProvider] ?? null}
      .now=${this.ticker.now}
    ></subscription-usage-row>`;
  }

  private renderProviderSetting(setting: ProviderSetting): TemplateResult {
    const warningLink =
      setting.warningUrl && setting.warningUrlLabel
        ? html` <wa-button
            class="provider-setting-link btn-ghost is-link"
            appearance="plain"
            size="s"
            @click=${() =>
              postMessage(SETTINGS_VIEW_COMMANDS.OPEN_EXTERNAL_URL, {
                url: setting.warningUrl!,
              })}
          >
            ${setting.warningUrlLabel}
          </wa-button>`
        : nothing;

    const warning = setting.warning
      ? html`<span class="provider-setting-warning"
          >${setting.warning}${warningLink}</span
        >`
      : nothing;

    return html`
      <div class="provider-setting provider-setting--block">
        <wa-switch
          ?checked=${setting.value}
          @change=${(e: Event) =>
            postStateSetting(setting.key, (e.target as WaSwitch).checked)}
        >
          ${setting.label}
        </wa-switch>
        <span class="provider-setting-description">${setting.description}</span>
        ${warning}
      </div>
    `;
  }

  private renderRow(entry: ProviderKeyStatus): TemplateResult {
    const isExpanded = this.expandedProvider === entry.provider;

    return html`
      <section class="settings-disclosure" role="listitem">
        <div class="settings-disclosure-summary">
          <wa-button
            class="settings-disclosure-toggle"
            appearance="plain"
            size="s"
            aria-expanded=${String(isExpanded)}
            aria-label=${`${entry.displayName} settings`}
            title="${isExpanded ? 'Collapse settings' : 'Expand settings'}"
            @click=${() => this.toggleExpanded(entry.provider)}
          >
            ${waIcon('chevron-right', {
              className: 'settings-disclosure-chevron',
            })}
            <span class="provider-name"
              ><bdi dir="auto">${entry.displayName}</bdi></span
            >
          </wa-button>
          <span class="settings-disclosure-status">
            ${renderKeyStatusIcon(entry.status)}
          </span>
          <div class="settings-disclosure-actions">
            ${this.renderActions(entry)}
          </div>
        </div>
        ${
          entry.provider === 'anthropic' &&
          (isExpanded || entry.status !== 'set')
            ? renderPlanCreditsHint()
            : nothing
        }
        ${isExpanded ? this.renderDetails(entry) : nothing}
      </section>
    `;
  }

  override render(): TemplateResult {
    const description =
      "Add a key from each provider's developer console. Kimi Code and GLM Coding Plan keys go on their rows; a ChatGPT or Grok plan signs in below instead.";

    return html`
      <div class="provider-keys-section">
        ${renderSettingsSectionHeading({
          title: 'API keys',
          description,
          icon: 'key',
        })}
        ${
          this.providerKeyStatuses === null
            ? html`<em class="text-secondary">Loading key status…</em>`
            : html`<div
                class="settings-disclosure-list"
                role="list"
                aria-label="Provider API keys"
              >
                ${this.providerKeyStatuses.map((entry) => this.renderRow(entry))}
              </div>`
        }
      </div>
    `;
  }
}

/** Under the Anthropic row while it has no key or is expanded: a Max or Team
 *  plan's monthly API credits are spent through the key this row sets. */
function renderPlanCreditsHint(): TemplateResult {
  return html`<p class="provider-row-hint">
    ${ANTHROPIC_PLAN_CREDITS.hint}
    <wa-button
      class="provider-setting-link btn-ghost is-link"
      appearance="plain"
      size="s"
      @click=${() =>
        postMessage(SETTINGS_VIEW_COMMANDS.OPEN_EXTERNAL_URL, {
          url: ANTHROPIC_PLAN_CREDITS.docUrl,
        })}
    >
      ${ANTHROPIC_PLAN_CREDITS.docLabel}
    </wa-button>
  </p>`;
}

declare global {
  interface HTMLElementTagNameMap {
    'provider-key-list': ProviderKeyList;
  }
}
