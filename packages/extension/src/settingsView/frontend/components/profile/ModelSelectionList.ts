/** Checkbox list of models grouped by provider, with deprecated toggles and helper-model picker. */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';

// Local imports - shared constants
import {
  PROVIDER_DISPLAY_NAMES,
  MODEL_PROVIDERS_ORDER,
} from '@shared/constants/providers';
import {
  EXPENSIVE_MODEL_HINT,
  isExpensiveModel,
} from '@shared/constants/expensiveModels';

// Local imports - profile view styles and events
import {
  ReasoningLevelSchema,
  type ModelSelectionItem,
  type ProviderKeyStatus,
  type ReasoningLevel,
} from '@shared/schemas/settingsViewMessages';
import { profileViewStyles } from './styles';
import { ModelSelectionEvents, ProviderKeyEvents } from './events';
import { resolveProviderKeyRows } from './providerKeyRows';
import type WaSelect from '@awesome.me/webawesome/dist/components/select/select.js';
import type WaCheckbox from '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';
import type WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';

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

/** Stable sort: fast-first-response models bubble to the top of their provider. */
function sortFastFirst(items: ModelSelectionItem[]): ModelSelectionItem[] {
  return [...items].sort((a, b) => {
    const aFast = a.isFast ? 0 : 1;
    const bFast = b.isFast ? 0 : 1;
    return aFast - bFast;
  });
}

@customElement('model-selection-list')
export class ModelSelectionList extends LitElement {
  static override styles = [designTokens, commonViewStyles, profileViewStyles];

  @property({ attribute: false }) models: ModelSelectionItem[] = [];
  @property({ attribute: false }) helperModel = '';
  @property({ attribute: false }) authenticated = false;
  @property({ attribute: false }) apiAccessMode: 'included' | 'personal' =
    'personal';
  @property({ attribute: false }) allowedModels: string[] | null = [];
  @property({ attribute: false }) providerKeyStatuses: ProviderKeyStatus[] = [];

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
          current: sortFastFirst(models.filter((m) => !m.deprecated)),
          deprecated: models.filter((m) => m.deprecated),
        };
      },
    );
  }

  private getProviderKeyStatus(
    provider: string,
  ): ProviderKeyStatus | undefined {
    return resolveProviderKeyRows(this.providerKeyStatuses).find(
      (entry) => entry.provider === provider,
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
    const select = e.currentTarget as WaSelect | null;
    const value = typeof select?.value === 'string' ? select.value : '';
    this.dispatchEvent(
      ModelSelectionEvents.setHelperModel({ modelName: value }),
    );
  }

  private handleReasoningLevelChange(modelName: string, e: Event): void {
    const select = e.currentTarget as WaSelect | null;
    const value = typeof select?.value === 'string' ? select.value : '';
    this.dispatchEvent(
      ModelSelectionEvents.setReasoningLevel({
        modelName,
        level: value === '' ? null : value,
      }),
    );
  }

  private getIncludedAccessReasoningCap(
    model: ModelSelectionItem,
  ): ReasoningLevel | null {
    if (
      !this.authenticated ||
      this.apiAccessMode !== 'included' ||
      !this.isRelayAvailable(model.name) ||
      model.reasoningLevel ||
      !model.includedAccessReasoningCap
    ) {
      return null;
    }
    return model.includedAccessReasoningCap;
  }

  private renderReasoningDropdown(
    model: ModelSelectionItem,
  ): TemplateResult | typeof nothing {
    if (!model.supportsReasoningLevel) return nothing;

    const currentValue = model.reasoningLevel ?? '';
    const includedAccessCap = this.getIncludedAccessReasoningCap(model);
    const defaultLabel = model.defaultReasoningLevel
      ? `Default (${REASONING_LEVEL_LABELS[model.defaultReasoningLevel]})`
      : 'Default';
    const title = includedAccessCap
      ? `Reasoning level. Included Access uses the TeXRA relay and caps this model's default Extra high reasoning to ${REASONING_LEVEL_LABELS[includedAccessCap]}. Use your own provider API key for uncapped provider-side access.`
      : 'Reasoning level';

    return html`
      <wa-select
        class="reasoning-level-select"
        .value=${currentValue}
        title=${title}
        @change=${(e: Event) => this.handleReasoningLevelChange(model.name, e)}
      >
        <wa-option value=""> ${defaultLabel} </wa-option>
        ${REASONING_LEVELS.map(
          (level) => html`
            <wa-option value=${level}>
              ${REASONING_LEVEL_LABELS[level]}
            </wa-option>
          `,
        )}
      </wa-select>
      ${includedAccessCap
        ? html`<wa-icon
            library="texra"
            name="warning"
            class="model-row-icon model-row-icon--warning"
            title=${title}
            aria-hidden="true"
          ></wa-icon>`
        : nothing}
    `;
  }

  private renderModelRow(model: ModelSelectionItem): TemplateResult {
    const available = this.isRelayAvailable(model.name);
    const unavailableClass = !available ? ' model-row--unavailable' : '';

    return html`
      <div class="model-row${unavailableClass}">
        <wa-checkbox
          ?checked=${model.enabled}
          @change=${(e: Event) => {
            const checked = (e.target as WaCheckbox).checked;
            this.dispatchEvent(
              ModelSelectionEvents.setModelEnabled({
                modelName: model.name,
                enabled: checked,
              }),
            );
          }}
        >
          <span class="model-name">${model.label}</span>
          <span class="model-shortname">(${model.name})</span>
          ${!available
            ? html`<wa-icon
                library="texra"
                name="key"
                class="model-row-icon"
                title="Requires ${PROVIDER_DISPLAY_NAMES[model.provider] ??
                model.provider} API key — set via TeXRA: Set API Key command"
              ></wa-icon>`
            : nothing}
          ${isExpensiveModel(model.provider, model.name)
            ? html`<wa-icon
                library="texra"
                name="warning"
                class="model-row-icon model-row-icon--warning"
                title=${EXPENSIVE_MODEL_HINT}
              ></wa-icon>`
            : nothing}
        </wa-checkbox>
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
    const keyStatus = this.getProviderKeyStatus(group.provider);
    let keyStatusLabel: string;
    switch (keyStatus?.status) {
      case 'set':
        keyStatusLabel = 'Key set';
        break;
      case 'env':
        keyStatusLabel = 'Env key';
        break;
      default:
        keyStatusLabel = 'No key';
    }
    const keyStatusVariant: 'success' | 'neutral' =
      keyStatus?.status === 'set' ? 'success' : 'neutral';
    const providerKeyActions = keyStatus
      ? html`
          <wa-tag
            class="provider-group-key-status"
            variant=${keyStatusVariant}
            size="small"
            >${keyStatusLabel}</wa-tag
          >
          ${renderLabeledActionButton({
            icon: 'key',
            text: 'Set key',
            label: `Set ${group.displayName} API key`,
            className: 'provider-group-key-button',
            onClick: () =>
              this.dispatchEvent(
                ProviderKeyEvents.setKey({ provider: group.provider }),
              ),
          })}
          ${renderLabeledActionButton({
            icon: 'arrow-up-right-from-square',
            text: 'Get key',
            label: `Get ${group.displayName} API key`,
            className: 'provider-group-key-button',
            onClick: () =>
              this.dispatchEvent(
                ProviderKeyEvents.openKeyUrl({ provider: group.provider }),
              ),
          })}
        `
      : nothing;

    return html`
      <div class="provider-group">
        <div class="provider-group-header">
          <button
            class="provider-group-toggle"
            @click=${() => this.toggleProvider(group.provider)}
          >
            <wa-icon
              library="texra"
              name="chevron-right"
              class="provider-group-chevron ${isExpanded ? 'expanded' : ''}"
            ></wa-icon>
            <span class="provider-group-name">${group.displayName}</span>
            <span class="provider-group-count">
              ${enabledCount}/${totalCount} enabled
            </span>
          </button>
          <div class="provider-group-actions">${providerKeyActions}</div>
        </div>
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
      <wa-button
        class="deprecated-toggle"
        appearance="plain"
        size="small"
        @click=${() => this.toggleDeprecated(group.provider)}
      >
        ${chevron} ${group.deprecated.length} deprecated
      </wa-button>
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
        <wa-select
          class="helper-model-select"
          .value=${this.helperModel}
          @change=${this.handleHelperModelChange}
        >
          ${enabledModels.map(
            (m) => html`<wa-option value=${m.name}> ${m.name} </wa-option>`,
          )}
        </wa-select>
      </div>
    `;
  }

  override render(): TemplateResult {
    const groups = this.getProviderGroups();

    return html`
      <div class="model-selection-section">
        <h2>Model Selection</h2>
        ${this.renderHelperModelDropdown()}
        <div class="short-names-toggle">
          <wa-switch
            ?checked=${this.preferShortModelNames}
            @change=${(e: Event) => {
              const enabled = (e.target as WaSwitch).checked;
              this.dispatchEvent(
                ModelSelectionEvents.setPreferShortModelNames({ enabled }),
              );
            }}
          >
            Use short model names
          </wa-switch>
          <span class="short-names-description">
            Send unpinned names (e.g. gpt-5.5 instead of gpt-5.5-2026-04-15)
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
