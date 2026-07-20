/** Checkbox list of models grouped by provider, with deprecated toggles and helper-model picker. */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import {
  renderSetStatusIcon,
  statusCheckIconStyles,
} from '@shared/wa/statusIcons';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';
import '@awesome.me/webawesome/dist/components/button/button.js';

// Local imports - shared constants
import {
  PROVIDER_DISPLAY_NAMES,
  MODEL_SOURCE_ORDER,
  EXPENSIVE_MODEL_HINT,
  isExpensiveModel,
} from '@shared/constants/providers';

// Local imports - profile view styles and events
import {
  REASONING_LEVEL_LABELS,
  REASONING_LEVEL_OPTIONS,
  type ModelSelectionItem,
  type ProviderKeyStatus,
  type ReasoningLevel,
} from '@shared/schemas/settingsViewMessages';
import { modelSelectionListStyles } from './ModelSelectionList.styles';
import { resolveProviderKeyRows } from './providerKeyRows';
import type WaSelect from '@awesome.me/webawesome/dist/components/select/select.js';
import type WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';

interface ProviderGroup {
  provider: string;
  displayName: string;
  current: ModelSelectionItem[];
  deprecated: ModelSelectionItem[];
}

/** Stable sort: fast-first-response models bubble to the top of their provider. */
function sortFastFirst(items: ModelSelectionItem[]): ModelSelectionItem[] {
  return items.toSorted(
    (a, b) => Number(Boolean(b.isFast)) - Number(Boolean(a.isFast)),
  );
}

@customElement('model-selection-list')
export class ModelSelectionList extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    statusCheckIconStyles,
    modelSelectionListStyles,
  ];

  @property({ attribute: false }) models: ModelSelectionItem[] = [];
  @property({ attribute: false }) helperModel = '';
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

    return MODEL_SOURCE_ORDER.filter((p) => byProvider.has(p)).map(
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

  private readSelectValue(e: Event): string {
    const select = e.currentTarget as WaSelect | null;
    return typeof select?.value === 'string' ? select.value : '';
  }

  private handleHelperModelChange(e: Event): void {
    postMessage(SETTINGS_VIEW_COMMANDS.SET_HELPER_MODEL, {
      modelName: this.readSelectValue(e),
    });
  }

  private handleReasoningLevelChange(modelName: string, e: Event): void {
    const value = this.readSelectValue(e);
    postMessage(SETTINGS_VIEW_COMMANDS.SET_MODEL_REASONING_LEVEL, {
      modelName,
      level: value === '' ? null : value,
    });
  }

  private getIncludedAccessReasoningCap(
    model: ModelSelectionItem,
  ): ReasoningLevel | null {
    // The cap only applies when the model is actually reachable through
    // included access; availability is resolved upstream and carried on the
    // item, so no relay/auth re-derivation is needed here.
    if (
      model.availability !== 'included-access' ||
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
        ?disabled=${model.disabled}
        @change=${(e: Event) => this.handleReasoningLevelChange(model.name, e)}
      >
        <wa-option value=""> ${defaultLabel} </wa-option>
        ${REASONING_LEVEL_OPTIONS.map(
          (option) => html`
            <wa-option value=${option.value}> ${option.label} </wa-option>
          `,
        )}
      </wa-select>
      ${
        includedAccessCap
          ? waIcon('warning', {
              className: 'model-row-icon model-row-icon--warning',
              title,
            })
          : nothing
      }
    `;
  }

  private renderAvailabilityIcon(
    model: ModelSelectionItem,
  ): TemplateResult | typeof nothing {
    if (!model.disabled) return nothing;

    const title = model.requiresKey
      ? `${model.availabilityLabel ?? 'Missing API key'} — configure it in API Configuration`
      : (model.availabilityLabel ?? 'Unavailable');
    const iconName = model.requiresKey ? 'key' : 'warning';
    const className = model.requiresKey
      ? 'model-row-icon'
      : 'model-row-icon model-row-icon--warning';

    return waIcon(iconName, { className, title });
  }

  private renderModelRow(model: ModelSelectionItem): TemplateResult {
    const available = !model.disabled;
    const unavailableClass = !available ? ' model-row--unavailable' : '';

    return html`
      <div class="model-row${unavailableClass}">
        <wa-switch
          ?checked=${model.enabled}
          ?disabled=${!available && !model.enabled}
          @change=${(e: Event) => {
            const checked = (e.target as WaSwitch).checked;
            postMessage(SETTINGS_VIEW_COMMANDS.SET_MODEL_ENABLED, {
              modelName: model.name,
              enabled: checked,
            });
          }}
        >
          <span class="model-name">${model.label}</span>
          <span class="model-shortname">(${model.name})</span>
          ${
            model.routeLabel
              ? html`<span class="model-route">· ${model.routeLabel}</span>`
              : nothing
          }
          ${this.renderAvailabilityIcon(model)}
          ${
            isExpensiveModel(model.provider, model.name)
              ? waIcon('warning', {
                  className: 'model-row-icon model-row-icon--warning',
                  title: EXPENSIVE_MODEL_HINT,
                })
              : nothing
          }
        </wa-switch>
        ${this.renderReasoningDropdown(model)}
        <span class="model-metadata">
          ${
            model.contextWindow
              ? html`<span>${model.contextWindow}</span>`
              : nothing
          }
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
    // Key status is read-only here. Setting, fetching, and removing keys all
    // live in the API Configuration section above; mirroring those actions in
    // this list produced two competing key UIs. Labels match that section.
    const providerKeyStatus = keyStatus
      ? html`
          <span class="provider-group-key-status">
            ${renderSetStatusIcon({
              status: keyStatus.status,
              title: 'Key set',
              fallbacks: {
                env: { label: 'Env' },
                'not-set': { label: 'Not set' },
              },
            })}
          </span>
        `
      : nothing;

    return html`
      <div class="provider-group">
        <div class="provider-group-header">
          <wa-button
            class="provider-group-toggle"
            appearance="plain"
            variant="neutral"
            @click=${() => this.toggleProvider(group.provider)}
          >
            ${waIcon('chevron-right', {
              className: isExpanded
                ? 'provider-group-chevron expanded'
                : 'provider-group-chevron',
            })}
            <span class="provider-group-name">${group.displayName}</span>
            <span class="provider-group-count">
              ${enabledCount}/${totalCount} enabled
            </span>
          </wa-button>
          <div class="provider-group-actions">${providerKeyStatus}</div>
        </div>
        ${
          isExpanded
            ? html`
                <div class="provider-group-content">
                  ${group.current.map((m) => this.renderModelRow(m))}
                  ${
                    group.deprecated.length > 0
                      ? this.renderDeprecatedToggle(group)
                      : nothing
                  }
                </div>
              `
            : nothing
        }
      </div>
    `;
  }

  private renderDeprecatedToggle(group: ProviderGroup): TemplateResult {
    const isOpen = this.expandedDeprecated.has(group.provider);

    return html`
      <wa-button
        class="deprecated-toggle"
        appearance="plain"
        size="small"
        @click=${() => this.toggleDeprecated(group.provider)}
      >
        ${waIcon('chevron-right', {
          className: isOpen
            ? 'provider-group-chevron expanded'
            : 'provider-group-chevron',
        })}
        ${group.deprecated.length} deprecated
      </wa-button>
      ${
        isOpen
          ? html`<div class="deprecated-models">
              ${group.deprecated.map((m) => this.renderModelRow(m))}
            </div>`
          : nothing
      }
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
            (m) => html`
              <wa-option value=${m.name}>
                ${m.label === m.name ? m.name : `${m.label} (${m.name})`}
              </wa-option>
            `,
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
              postMessage(SETTINGS_VIEW_COMMANDS.SET_PREFER_SHORT_MODEL_NAMES, {
                enabled,
              });
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
