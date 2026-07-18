/** Provider API key statuses with set/remove/get-URL actions and per-provider settings. */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import {
  renderSetStatusIcon,
  statusCheckIconStyles,
} from '@shared/wa/statusIcons';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';

// Local imports - profile view styles and events
import type {
  ProviderKeyStatus,
  ProviderVscodeSetting,
} from '@shared/schemas/settingsViewMessages';
import { createEvent } from '@shared/utils/events';
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
  @property({ attribute: false }) globalStreamingDefault = true;

  @state() private expandedProvider: string | null = null;

  private toggleExpanded(provider: string): void {
    this.expandedProvider =
      this.expandedProvider === provider ? null : provider;
  }

  private renderKeyStatus(status: ProviderKeyStatus['status']): TemplateResult {
    return renderSetStatusIcon({
      status,
      title: 'Key set',
      fallbacks: {
        env: { label: 'Env' },
        'not-set': { label: 'Not set' },
      },
    });
  }

  private renderActions(entry: ProviderKeyStatus): TemplateResult {
    const { provider } = entry;
    const removeButton =
      entry.status === 'set'
        ? renderIconActionButton({
            id: `provider-key-remove-${provider}`,
            icon: 'trash',
            label: 'Remove',
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
          label: 'Set',
          tooltip: 'Set API key',
          // Bubbles to SettingsApp, which owns the desktop-vs-VS Code
          // provider-key entry flow (modal on desktop, host prompt otherwise).
          onClick: () =>
            this.dispatchEvent(createEvent('provider-key-set', { provider })),
        })}
        ${renderIconActionButton({
          id: `provider-key-get-${provider}`,
          icon: 'arrow-up-right-from-square',
          label: 'Get',
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

  private renderDetailRow(entry: ProviderKeyStatus): TemplateResult {
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
            <label>Custom endpoint</label>
            <wa-input
              class="endpoint-input"
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
      <tr class="provider-detail-row">
        <td colspan="3">
          <div class="provider-settings">
            ${streamingToggle} ${endpointInput}
            ${entry.vscodeSettings.map((s) => this.renderVscodeSetting(s))}
          </div>
        </td>
      </tr>
    `;
  }

  private renderVscodeSetting(setting: ProviderVscodeSetting): TemplateResult {
    const warningLink =
      setting.warningUrl && setting.warningUrlLabel
        ? html` <wa-button
            class="provider-setting-link"
            appearance="plain"
            size="small"
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
            postMessage(SETTINGS_VIEW_COMMANDS.SET_PROVIDER_VSCODE_SETTING, {
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

  private renderRow(
    entry: ProviderKeyStatus,
  ): TemplateResult | TemplateResult[] {
    const isExpanded = this.expandedProvider === entry.provider;

    const mainRow = html`
      <tr>
        <td>
          <div class="provider-name-cell">
            <wa-button
              class=${classMap({
                'provider-expand-btn': true,
                expanded: isExpanded,
              })}
              appearance="plain"
              size="small"
              title="${isExpanded ? 'Collapse settings' : 'Expand settings'}"
              @click=${() => this.toggleExpanded(entry.provider)}
            >
              ${waIcon('chevron-right')}
            </wa-button>
            <span class="provider-name">${entry.displayName}</span>
          </div>
        </td>
        <td>${this.renderKeyStatus(entry.status)}</td>
        <td>${this.renderActions(entry)}</td>
      </tr>
    `;

    if (isExpanded) {
      return [mainRow, this.renderDetailRow(entry)];
    }
    return mainRow;
  }

  private renderGlobalStreamingToggle(): TemplateResult {
    return html`
      <div class="global-streaming-toggle">
        <wa-switch
          ?checked=${this.globalStreamingDefault}
          @change=${(e: Event) => {
            const checked = (e.target as WaSwitch).checked;
            postMessage(SETTINGS_VIEW_COMMANDS.SET_GLOBAL_STREAMING, {
              enabled: checked,
            });
          }}
        >
          Enable streaming
        </wa-switch>
        <span class="global-streaming-description"
          >Global default for all providers</span
        >
      </div>
    `;
  }

  override render(): TemplateResult {
    const rows = resolveProviderKeyRows(this.providerKeyStatuses);

    const description =
      this.apiAccessMode === 'included'
        ? 'You are using included access. Personal keys below are optional overrides.'
        : 'Except for Codex models through the ChatGPT subscription section above, chat subscriptions do not include API access - use a key from the provider developer platform.';

    return html`
      <div class="provider-keys-section">
        <h2>API Configuration</h2>
        <p class="provider-keys-description">${description}</p>
        ${this.renderGlobalStreamingToggle()}
        <table class="provider-keys-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((entry) => this.renderRow(entry))}
          </tbody>
        </table>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'provider-key-list': ProviderKeyList;
  }
}
