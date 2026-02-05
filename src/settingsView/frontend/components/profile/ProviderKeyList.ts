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
import { profileViewStyles } from './styles';
import { ProviderKeyEvents } from './events';

// Local imports - shared schemas
import type { ProviderKeyStatus } from '@shared/schemas/settingsViewMessages';

const STATUS_LABELS: Record<ProviderKeyStatus['status'], string> = {
  set: 'Set',
  env: 'Env',
  'not-set': 'Not Set',
};

/** Providers that have no per-provider streaming config (Wolfram uses a different protocol). */
const NO_STREAMING_PROVIDERS = new Set(['wolframllmapp']);

@customElement('provider-key-list')
export class ProviderKeyList extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    ...badgeStyles,
    profileViewStyles,
  ];

  @property({ attribute: false }) providerKeyStatuses: ProviderKeyStatus[] = [];
  @property({ type: String }) apiAccessMode: 'included' | 'personal' =
    'personal';
  @property({ type: Boolean }) globalStreamingDefault = true;

  @state() private expandedProvider: string | null = null;

  private hasSettings(entry: ProviderKeyStatus): boolean {
    return (
      !NO_STREAMING_PROVIDERS.has(entry.provider) ||
      entry.supportsCustomEndpoint
    );
  }

  private toggleExpanded(provider: string): void {
    this.expandedProvider =
      this.expandedProvider === provider ? null : provider;
  }

  private renderStatusBadge(
    status: ProviderKeyStatus['status'],
  ): TemplateResult {
    return html`<span class="key-status-badge ${status}"
      >${STATUS_LABELS[status]}</span
    >`;
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
    const hasStreaming = !NO_STREAMING_PROVIDERS.has(entry.provider);

    const streamingToggle = hasStreaming
      ? html`
          <div class="provider-setting">
            <label>
              <input
                type="checkbox"
                .checked=${entry.streaming}
                @change=${(e: Event) => {
                  const checked = (e.target as HTMLInputElement).checked;
                  this.dispatchEvent(
                    ProviderKeyEvents.setStreaming({
                      provider: entry.provider,
                      enabled: checked,
                    }),
                  );
                }}
              />
              Streaming
            </label>
          </div>
        `
      : nothing;

    const endpointInput = entry.supportsCustomEndpoint
      ? html`
          <div class="provider-setting">
            <label>Custom endpoint</label>
            <input
              type="text"
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
            />
          </div>
        `
      : nothing;

    return html`
      <tr class="provider-detail-row">
        <td colspan="3">
          <div class="provider-settings">
            ${streamingToggle} ${endpointInput}
          </div>
        </td>
      </tr>
    `;
  }

  private renderRow(
    entry: ProviderKeyStatus,
  ): TemplateResult | TemplateResult[] {
    const hasSettings = this.hasSettings(entry);
    const isExpanded = this.expandedProvider === entry.provider;

    const chevron = hasSettings
      ? html`<button
          class="provider-expand-btn ${isExpanded ? 'expanded' : ''}"
          title="${isExpanded ? 'Collapse settings' : 'Expand settings'}"
          @click=${() => this.toggleExpanded(entry.provider)}
        >
          <span class="codicon codicon-chevron-right"></span>
        </button>`
      : nothing;

    const mainRow = html`
      <tr>
        <td>
          <div class="provider-name-cell">
            ${chevron}
            <span class="provider-name">${entry.displayName}</span>
          </div>
        </td>
        <td>${this.renderStatusBadge(entry.status)}</td>
        <td>${this.renderActions(entry)}</td>
      </tr>
    `;

    if (isExpanded && hasSettings) {
      return [mainRow, this.renderDetailRow(entry)];
    }
    return mainRow;
  }

  private renderGlobalStreamingToggle(): TemplateResult {
    return html`
      <div class="global-streaming-toggle">
        <label>
          <input
            type="checkbox"
            .checked=${this.globalStreamingDefault}
            @change=${(e: Event) => {
              const checked = (e.target as HTMLInputElement).checked;
              this.dispatchEvent(
                ProviderKeyEvents.setGlobalStreaming({ enabled: checked }),
              );
            }}
          />
          Enable streaming
        </label>
        <span class="global-streaming-description"
          >Global default for all providers</span
        >
      </div>
    `;
  }

  override render(): TemplateResult {
    if (this.providerKeyStatuses.length === 0) {
      return html``;
    }

    const description =
      this.apiAccessMode === 'included'
        ? 'You are using included access. Personal keys below are optional overrides.'
        : 'Set API keys for the providers you want to use.';

    return html`
      <div class="provider-keys-section">
        <h2>API Keys</h2>
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
            ${this.providerKeyStatuses.map((entry) => this.renderRow(entry))}
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
