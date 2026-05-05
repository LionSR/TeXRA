/**
 * ProviderKeyList component - displays provider API key statuses with set/remove/get-URL actions.
 * Includes collapsible per-provider settings for streaming and custom endpoints.
 */

// Third-party imports
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared styles
import { badgeStyles, codiconStyles, designTokens } from '@shared/styles';

// Local imports - profile view styles and events
import type {
  ProviderKeyStatus,
  ProviderVscodeSetting,
} from '@shared/schemas/settingsViewMessages';
import { profileViewStyles } from './styles';
import { ProviderKeyEvents } from './events';
import { resolveProviderKeyRows } from './providerKeyRows';

const STATUS_LABELS: Record<ProviderKeyStatus['status'], string> = {
  set: 'Set',
  env: 'Env',
  'not-set': 'Not Set',
};

@customElement('provider-key-list')
export class ProviderKeyList extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    ...badgeStyles,
    profileViewStyles,
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

  private renderActions(entry: ProviderKeyStatus): TemplateResult {
    const { provider } = entry;
    const removeButton =
      entry.status === 'set'
        ? html`<vscode-toolbar-button
            icon="trash"
            label="Remove"
            title="Remove key"
            @click=${() =>
              this.dispatchEvent(ProviderKeyEvents.removeKey({ provider }))}
          ></vscode-toolbar-button>`
        : nothing;

    return html`
      <div class="provider-actions">
        <vscode-toolbar-button
          icon="key"
          label="Set"
          title="Set API key"
          @click=${() =>
            this.dispatchEvent(ProviderKeyEvents.setKey({ provider }))}
        ></vscode-toolbar-button>
        <vscode-toolbar-button
          icon="link-external"
          label="Get"
          title="Get API key from provider"
          @click=${() =>
            this.dispatchEvent(ProviderKeyEvents.openKeyUrl({ provider }))}
        ></vscode-toolbar-button>
        ${removeButton}
      </div>
    `;
  }

  private renderDetailRow(entry: ProviderKeyStatus): TemplateResult {
    const streamingToggle = html`
      <div class="provider-setting">
        <vscode-checkbox
          ?checked=${entry.streaming}
          @change=${(e: Event) => {
            const checked = (e.target as HTMLInputElement).checked;
            this.dispatchEvent(
              ProviderKeyEvents.setStreaming({
                provider: entry.provider,
                enabled: checked,
              }),
            );
          }}
        >
          Streaming
        </vscode-checkbox>
      </div>
    `;

    const endpointInput = entry.supportsCustomEndpoint
      ? html`
          <div class="provider-setting">
            <label>Custom endpoint</label>
            <vscode-textfield
              class="endpoint-input"
              .value=${entry.customEndpoint}
              placeholder="Leave blank for default"
              @change=${(e: Event) => {
                const value = (e.target as HTMLInputElement).value.trim();
                this.dispatchEvent(
                  ProviderKeyEvents.setEndpoint({
                    provider: entry.provider,
                    endpoint: value,
                  }),
                );
              }}
            ></vscode-textfield>
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
        ? html` <button
            class="provider-setting-link"
            @click=${() =>
              this.dispatchEvent(
                ProviderKeyEvents.openUrl({ url: setting.warningUrl! }),
              )}
          >
            ${setting.warningUrlLabel}
          </button>`
        : nothing;

    const warning = setting.warning
      ? html`<span class="provider-setting-warning"
          >${setting.warning}${warningLink}</span
        >`
      : nothing;

    return html`
      <div class="provider-setting provider-setting--block">
        <vscode-checkbox
          ?checked=${setting.value}
          @change=${(e: Event) => {
            const checked = (e.target as HTMLInputElement).checked;
            this.dispatchEvent(
              ProviderKeyEvents.setVscodeSetting({
                key: setting.key,
                value: checked,
              }),
            );
          }}
        >
          ${setting.label}
        </vscode-checkbox>
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
            <button
              class="provider-expand-btn ${isExpanded ? 'expanded' : ''}"
              title="${isExpanded ? 'Collapse settings' : 'Expand settings'}"
              @click=${() => this.toggleExpanded(entry.provider)}
            >
              <span class="codicon codicon-chevron-right"></span>
            </button>
            <span class="provider-name">${entry.displayName}</span>
          </div>
        </td>
        <td>
          <span class="key-status-badge ${entry.status}"
            >${STATUS_LABELS[entry.status]}</span
          >
        </td>
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
        <vscode-checkbox
          ?checked=${this.globalStreamingDefault}
          @change=${(e: Event) => {
            const checked = (e.target as HTMLInputElement).checked;
            this.dispatchEvent(
              ProviderKeyEvents.setGlobalStreaming({ enabled: checked }),
            );
          }}
        >
          Enable streaming
        </vscode-checkbox>
        <span class="global-streaming-description"
          >Global default for all providers</span
        >
      </div>
    `;
  }

  override render(): TemplateResult | typeof nothing {
    const rows = resolveProviderKeyRows(this.providerKeyStatuses);

    const description =
      this.apiAccessMode === 'included'
        ? 'You are using included access. Personal keys below are optional overrides.'
        : 'Chat subscriptions (ChatGPT Plus, Claude Pro, etc.) do not include API access\u2014you need a key from the provider\u2019s developer platform.';

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
