/** Provider API key statuses with set/remove/get-URL actions and per-provider settings. */

import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import { DEFAULT_GLOBAL_STREAMING } from '@shared/schemas';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import {
  renderSettingsSectionHeading,
  renderSettingsToggleRow,
} from '@shared/wa/settingsSection';
import {
  renderKeyStatusIcon,
  statusCheckIconStyles,
} from '@shared/wa/statusIcons';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';

// Local imports - profile view styles and events
import type {
  ProviderKeyStatus,
  ProviderSetting,
} from '@shared/schemas/settingsViewMessages';
import { createEvent } from '@shared/utils/events';
import { INCLUDED_ACCESS } from '@shared/copy/modelAccess';
import { providerKeyListStyles } from './ProviderKeyList.styles';
import { resolveProviderKeyRows } from './providerKeyRows';
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

  @property({ attribute: false }) providerKeyStatuses: ProviderKeyStatus[] = [];
  @property({ attribute: false }) apiAccessMode: 'included' | 'personal' =
    'personal';
  @property({ attribute: false }) globalStreamingDefault =
    DEFAULT_GLOBAL_STREAMING;

  @state() private expandedProvider: string | null = null;

  private toggleExpanded(provider: string): void {
    this.expandedProvider =
      this.expandedProvider === provider ? null : provider;
  }

  private renderActions(entry: ProviderKeyStatus): TemplateResult {
    const { provider } = entry;
    const removeButton =
      entry.status === 'set'
        ? renderIconActionButton({
            id: `provider-key-remove-${provider}`,
            icon: 'trash',
            label: `Remove ${provider} key`,
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
          label: `Set ${provider} API key`,
          tooltip: 'Set API key',
          // Bubbles to SettingsApp, which owns the desktop-vs-VS Code
          // provider-key entry flow (modal on desktop, host prompt otherwise).
          onClick: () =>
            this.dispatchEvent(createEvent('provider-key-set', { provider })),
        })}
        ${renderIconActionButton({
          id: `provider-key-get-${provider}`,
          icon: 'arrow-up-right-from-square',
          label: `Get ${provider} API key`,
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
    const streamingToggle = html`
      <div class="provider-setting">
        <wa-switch
          ?checked=${entry.streaming}
          @change=${(e: Event) => {
            const checked = (e.target as WaSwitch).checked;
            postMessage(SETTINGS_VIEW_COMMANDS.SET_PROVIDER_STREAMING, {
              provider: entry.provider,
              enabled: checked,
            });
          }}
        >
          Streaming
        </wa-switch>
      </div>
    `;

    const endpointInput = entry.supportsCustomEndpoint
      ? html`
          <div class="provider-setting">
            <label for=${`endpoint-${entry.provider}`}>Custom endpoint</label>
            <wa-input
              id=${`endpoint-${entry.provider}`}
              class="endpoint-input form-control-fill"
              .value=${entry.customEndpoint}
              placeholder="Leave blank for default"
              @change=${(e: Event) => {
                const value = (e.target as WaInput).value?.trim() ?? '';
                postMessage(SETTINGS_VIEW_COMMANDS.SET_PROVIDER_ENDPOINT, {
                  provider: entry.provider,
                  endpoint: value,
                });
              }}
            ></wa-input>
          </div>
        `
      : nothing;

    return html`
      <div class="settings-disclosure-content provider-settings">
        ${streamingToggle} ${endpointInput}
        ${entry.providerSettings.map((s) => this.renderProviderSetting(s))}
      </div>
    `;
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
          @change=${(e: Event) => {
            const checked = (e.target as WaSwitch).checked;
            postMessage(SETTINGS_VIEW_COMMANDS.SET_PROVIDER_SETTING, {
              key: setting.key,
              value: checked,
            });
          }}
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
      <section class="settings-disclosure">
        <div class="settings-disclosure-summary">
          <wa-button
            class="settings-disclosure-toggle"
            appearance="plain"
            size="s"
            aria-expanded=${String(isExpanded)}
            title="${isExpanded ? 'Collapse settings' : 'Expand settings'}"
            @click=${() => this.toggleExpanded(entry.provider)}
          >
            ${waIcon('chevron-right', {
              className: 'settings-disclosure-chevron',
            })}
            <span class="provider-name">${entry.displayName}</span>
          </wa-button>
          <span class="settings-disclosure-status">
            ${renderKeyStatusIcon(entry.status)}
          </span>
          <div class="settings-disclosure-actions">
            ${this.renderActions(entry)}
          </div>
        </div>
        ${isExpanded ? this.renderDetails(entry) : nothing}
      </section>
    `;
  }

  override render(): TemplateResult {
    const rows = resolveProviderKeyRows(this.providerKeyStatuses);

    const description =
      this.apiAccessMode === 'included'
        ? `You are using ${INCLUDED_ACCESS.inline}. The keys below are optional overrides.`
        : "Except for Codex models through the ChatGPT subscription section above, chat subscriptions do not include API access. Use a key from the provider's developer console.";

    return html`
      <div class="provider-keys-section">
        ${renderSettingsSectionHeading({
          title: 'API configuration',
          description,
          icon: 'key',
        })}
        ${renderSettingsToggleRow({
          label: 'Enable streaming',
          description: 'Global default for all providers',
          checked: this.globalStreamingDefault,
          onChange: (e: Event) => {
            const checked = (e.target as WaSwitch).checked;
            postMessage(SETTINGS_VIEW_COMMANDS.SET_GLOBAL_STREAMING, {
              enabled: checked,
            });
          },
        })}
        <div class="settings-disclosure-list">
          ${rows.map((entry) => this.renderRow(entry))}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'provider-key-list': ProviderKeyList;
  }
}
