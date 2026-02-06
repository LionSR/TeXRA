/**
 * ModelSelectionList component - checkbox list of models grouped by provider.
 * Includes deprecated model toggles and a polish model dropdown.
 */

// Third-party imports
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared styles
import { codiconStyles, designTokens } from '@shared/styles';

// Local imports - shared constants
import {
  PROVIDER_DISPLAY_NAMES,
  MODEL_PROVIDERS_ORDER,
} from '@shared/constants/providers';

// Local imports - shared schemas
import type { ModelSelectionItem } from '@shared/schemas/settingsViewMessages';

// Local imports - profile view styles and events
import { profileViewStyles } from './styles';
import { ModelSelectionEvents } from './events';

interface ProviderGroup {
  provider: string;
  displayName: string;
  current: ModelSelectionItem[];
  deprecated: ModelSelectionItem[];
}

@customElement('model-selection-list')
export class ModelSelectionList extends LitElement {
  static override styles = [designTokens, codiconStyles, profileViewStyles];

  @property({ attribute: false }) models: ModelSelectionItem[] = [];
  @property({ type: String }) polishModel = '';
  @property({ type: Boolean }) authenticated = false;
  @property({ type: String }) apiAccessMode: 'included' | 'personal' =
    'personal';
  @property({ attribute: false }) allowedModels: string[] | null = [];

  @state() private expandedProvider: string | null = null;
  @state() private expandedDeprecated: Set<string> = new Set();

  private getProviderGroups(): ProviderGroup[] {
    const byProvider = new Map<string, ModelSelectionItem[]>();
    for (const model of this.models) {
      const list = byProvider.get(model.provider) ?? [];
      list.push(model);
      byProvider.set(model.provider, list);
    }

    return MODEL_PROVIDERS_ORDER.filter((p) => byProvider.has(p)).map(
      (provider) => {
        const models = byProvider.get(provider)!;
        return {
          provider,
          displayName: PROVIDER_DISPLAY_NAMES[provider] ?? provider,
          current: models.filter((m) => !m.deprecated),
          deprecated: models.filter((m) => m.deprecated),
        };
      },
    );
  }

  private getEnabledModels(): ModelSelectionItem[] {
    return this.models.filter((m) => m.enabled);
  }

  private toggleProvider(provider: string): void {
    this.expandedProvider =
      this.expandedProvider === provider ? null : provider;
  }

  private toggleDeprecated(provider: string): void {
    const next = new Set(this.expandedDeprecated);
    if (next.has(provider)) {
      next.delete(provider);
    } else {
      next.add(provider);
    }
    this.expandedDeprecated = next;
  }

  /**
   * Check if a model is available via the relay (included access).
   * Returns true if using personal keys, or if relay allows all models, or if model is in allowed list.
   */
  private isRelayAvailable(modelName: string): boolean {
    if (!this.authenticated || this.apiAccessMode !== 'included') {
      return true; // personal keys - no relay restriction
    }
    if (this.allowedModels === null) {
      return true; // Ultra tier - all models
    }
    return this.allowedModels.includes(modelName);
  }

  private handleModelToggle(modelName: string, checked: boolean): void {
    this.dispatchEvent(
      ModelSelectionEvents.setModelEnabled({
        modelName,
        enabled: checked,
      }),
    );
  }

  private handlePolishModelChange(e: Event): void {
    const value = (e.target as HTMLSelectElement).value;
    this.dispatchEvent(
      ModelSelectionEvents.setPolishModel({ modelName: value }),
    );
  }

  private renderModelRow(model: ModelSelectionItem): TemplateResult {
    const available = this.isRelayAvailable(model.name);
    const unavailableClass = !available ? ' model-row--unavailable' : '';

    return html`
      <div class="model-row${unavailableClass}">
        <label>
          <input
            type="checkbox"
            .checked=${model.enabled}
            @change=${(e: Event) => {
              const checked = (e.target as HTMLInputElement).checked;
              this.handleModelToggle(model.name, checked);
            }}
          />
          <span class="model-name">${model.name}</span>
          ${!available
            ? html`<span
                class="codicon codicon-key model-key-icon"
                title="Requires personal API key"
              ></span>`
            : nothing}
        </label>
        <span class="model-metadata">
          ${model.contextWindow
            ? html`<span>${model.contextWindow}</span>`
            : nothing}
          ${model.cost ? html`<span>${model.cost}</span>` : nothing}
        </span>
      </div>
    `;
  }

  private renderProviderGroup(group: ProviderGroup): TemplateResult {
    const isExpanded = this.expandedProvider === group.provider;
    const enabledCurrentCount = group.current.filter((m) => m.enabled).length;
    const totalCurrentCount = group.current.length;

    const content = isExpanded
      ? html`
          <div class="provider-group-content">
            ${group.current.map((m) => this.renderModelRow(m))}
            ${group.deprecated.length > 0
              ? this.renderDeprecatedToggle(group)
              : nothing}
          </div>
        `
      : nothing;

    return html`
      <div class="provider-group">
        <button
          class="provider-group-header"
          @click=${() => this.toggleProvider(group.provider)}
        >
          <span
            class="provider-group-chevron codicon codicon-chevron-right ${isExpanded
              ? 'expanded'
              : ''}"
          ></span>
          <span class="provider-group-name">${group.displayName}</span>
          <span class="provider-group-count">
            ${enabledCurrentCount}/${totalCurrentCount} enabled
          </span>
        </button>
        ${content}
      </div>
    `;
  }

  private renderDeprecatedToggle(group: ProviderGroup): TemplateResult {
    const isOpen = this.expandedDeprecated.has(group.provider);
    const chevron = isOpen ? '\u25BE' : '\u25B8';

    return html`
      <button
        class="deprecated-toggle"
        @click=${() => this.toggleDeprecated(group.provider)}
      >
        ${chevron} ${group.deprecated.length} deprecated
      </button>
      ${isOpen
        ? html`<div class="deprecated-models">
            ${group.deprecated.map((m) => this.renderModelRow(m))}
          </div>`
        : nothing}
    `;
  }

  private renderPolishModelDropdown(): TemplateResult {
    const enabledModels = this.getEnabledModels();

    return html`
      <div class="polish-model-row">
        <label>Polish model:</label>
        <select
          class="polish-model-select"
          .value=${this.polishModel}
          @change=${this.handlePolishModelChange}
        >
          ${enabledModels.map(
            (m) =>
              html`<option
                value=${m.name}
                ?selected=${m.name === this.polishModel}
              >
                ${m.name}
              </option>`,
          )}
        </select>
      </div>
    `;
  }

  override render(): TemplateResult {
    const groups = this.getProviderGroups();

    return html`
      <div class="model-selection-section">
        <h2>Model Selection</h2>
        <p class="model-selection-description">
          Select which models appear in the dropdown.
        </p>
        ${this.renderPolishModelDropdown()}
        ${groups.map((g) => this.renderProviderGroup(g))}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'model-selection-list': ModelSelectionList;
  }
}
