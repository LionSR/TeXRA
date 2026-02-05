/**
 * ProviderKeyList component - displays provider API key statuses with set/remove/get-URL actions.
 */

// Third-party imports
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { badgeStyles, designTokens } from '@shared/styles';

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

@customElement('provider-key-list')
export class ProviderKeyList extends LitElement {
  static override styles = [designTokens, ...badgeStyles, profileViewStyles];

  @property({ attribute: false }) providerKeyStatuses: ProviderKeyStatus[] = [];
  @property({ type: String }) apiAccessMode: 'included' | 'personal' =
    'personal';

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

  private renderRow(entry: ProviderKeyStatus): TemplateResult {
    return html`
      <tr>
        <td class="provider-name">${entry.displayName}</td>
        <td>${this.renderStatusBadge(entry.status)}</td>
        <td>${this.renderActions(entry)}</td>
      </tr>
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
