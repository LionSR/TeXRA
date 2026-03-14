/**
 * ModelSelectionList component - checkbox list of models grouped by provider.
 * Includes deprecated model toggles and a helper model dropdown.
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

// Local imports - profile view styles and events
import {
  ReasoningLevelSchema,
  type ModelSelectionItem,
  type ReasoningLevel,
} from '@shared/schemas/settingsViewMessages';
import { profileViewStyles } from './styles';
import { ModelSelectionEvents } from './events';

/** Display labels for reasoning level options. */
const REASONING_LEVEL_LABELS: Record<ReasoningLevel, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const REASONING_LEVELS = ReasoningLevelSchema.options;

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
  @property({ attribute: false }) helperModel = '';
  @property({ attribute: false }) authenticated = false;
  @property({ attribute: false }) apiAccessMode: 'included' | 'personal' =
    'personal';
  @property({ attribute: false }) allowedModels: string[] | null = [];

  @property({ type: Boolean, attribute: 'prefer-short-model-names' })
  preferShortModelNames = false;

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

  private handleHelperModelChange(e: Event): void {
    const value = (e.currentTarget as HTMLSelectElement).value;
    this.dispatchEvent(
      ModelSelectionEvents.setHelperModel({ modelName: value }),
    );
  }

  private handleReasoningLevelChange(modelName: string, e: Event): void {
    const value = (e.currentTarget as HTMLSelectElement).value;
    this.dispatchEvent(
      ModelSelectionEvents.setReasoningLevel({
        modelName,
        level: value === '' ? null : value,
      }),
    );
  }

  private renderReasoningDropdown(
    model: ModelSelectionItem,
  ): TemplateResult | typeof nothing {
    if (!model.supportsReasoningLevel) return nothing;

    const currentValue = model.reasoningLevel ?? '';
    const defaultLabel = model.defaultReasoningLevel
      ? `Default (${REASONING_LEVEL_LABELS[model.defaultReasoningLevel]})`
      : 'Default';

    return html`
      <vscode-single-select
        class="reasoning-level-select"
        .value=${currentValue}
        title="Reasoning level"
        @change=${(e: Event) => this.handleReasoningLevelChange(model.name, e)}
      >
        <vscode-option value="" ?selected=${currentValue === ''}>
          ${defaultLabel}
        </vscode-option>
        ${REASONING_LEVELS.map(
          (level) => html`
            <vscode-option value=${level} ?selected=${currentValue === level}>
              ${REASONING_LEVEL_LABELS[level]}
            </vscode-option>
          `,
        )}
      </vscode-single-select>
    `;
  }

  private renderModelRow(model: ModelSelectionItem): TemplateResult {
    const available = this.isRelayAvailable(model.name);
    const unavailableClass = !available ? ' model-row--unavailable' : '';

    return html`
      <div class="model-row${unavailableClass}">
        <vscode-checkbox
          ?checked=${model.enabled}
          @change=${(e: Event) => {
            const checked = (e.target as HTMLInputElement).checked;
            this.dispatchEvent(
              ModelSelectionEvents.setModelEnabled({
                modelName: model.name,
                enabled: checked,
              }),
            );
          }}
        >
          <span class="model-name">${model.name}</span>
          ${!available
            ? html`<span
                class="codicon codicon-key model-key-icon"
                title="Requires personal API key"
              ></span>`
            : nothing}
        </vscode-checkbox>
        ${this.renderReasoningDropdown(model)}
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
    const enabledCount = group.current.filter((m) => m.enabled).length;
    const totalCount = group.current.length;

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
            ${enabledCount}/${totalCount} enabled
          </span>
        </button>
        ${isExpanded
          ? html`
              <div class="provider-group-content">
                ${group.current.map((m) => this.renderModelRow(m))}
                ${group.deprecated.length > 0
                  ? this.renderDeprecatedToggle(group)
                  : nothing}
              </div>
            `
          : nothing}
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

  private renderHelperModelDropdown(): TemplateResult {
    const enabledModels = this.models.filter((m) => m.enabled);

    return html`
      <div class="helper-model-row">
        <label>Helper model:</label>
        <vscode-single-select
          class="helper-model-select"
          .value=${this.helperModel}
          @change=${this.handleHelperModelChange}
        >
          ${enabledModels.map(
            (m) =>
              html`<vscode-option
                value=${m.name}
                ?selected=${m.name === this.helperModel}
              >
                ${m.name}
              </vscode-option>`,
          )}
        </vscode-single-select>
      </div>
    `;
  }

  override render(): TemplateResult {
    const groups = this.getProviderGroups();

    return html`
      <div class="model-selection-section">
        <h2>Models & API</h2>
        ${this.renderHelperModelDropdown()}
        <div class="short-names-toggle">
          <vscode-checkbox
            ?checked=${this.preferShortModelNames}
            @change=${(e: Event) => {
              const enabled = (e.target as HTMLInputElement).checked;
              this.dispatchEvent(
                ModelSelectionEvents.setPreferShortModelNames({ enabled }),
              );
            }}
          >
            Use short model names
          </vscode-checkbox>
          <span class="short-names-description">
            Send unpinned names (e.g. gpt-5.4 instead of gpt-5.4-2026-03-05)
          </span>
        </div>
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
