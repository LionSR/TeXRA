/** Checkbox list of models grouped by provider, with deprecated toggles and helper-model picker. */

import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import {
  REASONING_LEVEL_LABELS,
  REASONING_LEVEL_OPTIONS,
  type ModelSelectionItem,
  type ProviderKeyStatus,
  type ReasoningLevel,
} from '@shared/schemas';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import {
  renderKeyStatusIcon,
  statusCheckIconStyles,
} from '@shared/wa/statusIcons';
import { renderSettingsSectionHeading } from '@shared/wa/settingsSection';

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
import { readSelectValue } from '@shared/utils/selectTemplates';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { INCLUDED_ACCESS, OWN_API_KEYS } from '@shared/copy/modelAccess';
import { postStateSetting } from '../shared/stateSettingRows';
import { modelSelectionListStyles } from './ModelSelectionList.styles';
import { resolveProviderKeyRows } from './providerKeyRows';
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

  private handleHelperModelChange(e: Event): void {
    postStateSetting(GlobalStateKey.HELPER_MODEL, readSelectValue(e));
  }

  private handleReasoningLevelChange(modelName: string, e: Event): void {
    const value = readSelectValue(e);
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
      ? `Reasoning level. ${INCLUDED_ACCESS.label} caps this model's default Extra high reasoning to ${REASONING_LEVEL_LABELS[includedAccessCap]}. Switch to ${OWN_API_KEYS.inline} for the full range.`
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
          ? waIcon('triangle-exclamation', {
              className: 'model-row-icon model-row-icon--warning',
              // `label` as well as `title`: a titled but aria-hidden icon
              // never reaches assistive technology.
              label: title,
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

    // The backend resolves the label alongside `disabled`; the Models tab
    // shows that verdict verbatim rather than inventing a reason.
    const { availabilityLabel } = model;
    const title =
      model.requiresKey && availabilityLabel
        ? `${availabilityLabel} — add a key in API configuration`
        : availabilityLabel;
    const iconName = model.requiresKey ? 'key' : 'triangle-exclamation';
    const className = model.requiresKey
      ? 'model-row-icon'
      : 'model-row-icon model-row-icon--warning';

    return waIcon(iconName, { className, label: title, title });
  }

  private renderModelRow(model: ModelSelectionItem): TemplateResult {
    return html`
      <div class="model-row">
        <wa-switch
          ?checked=${model.enabled}
          ?disabled=${model.disabled && !model.enabled}
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
              ? waIcon('triangle-exclamation', {
                  className: 'model-row-icon model-row-icon--warning',
                  label: EXPENSIVE_MODEL_HINT,
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
    const keyStatus = resolveProviderKeyRows(this.providerKeyStatuses).find(
      (entry) => entry.provider === group.provider,
    );
    // Key status is read-only here. Setting, fetching, and removing keys all
    // live in the API Configuration section above; mirroring those actions in
    // this list produced two competing key UIs.
    const providerKeyStatus = keyStatus
      ? html`
          <span class="provider-group-key-status">
            ${renderKeyStatusIcon(keyStatus.status)}
          </span>
        `
      : nothing;

    return html`
      <section class="provider-group settings-disclosure">
        <div class="provider-group-header settings-disclosure-summary">
          <wa-button
            class="provider-group-toggle settings-disclosure-toggle"
            appearance="plain"
            variant="neutral"
            aria-expanded=${String(isExpanded)}
            @click=${() => this.toggleProvider(group.provider)}
          >
            ${waIcon('chevron-right', {
              className: 'settings-disclosure-chevron',
            })}
            <span class="provider-group-name">${group.displayName}</span>
            <span class="provider-group-count">
              ${enabledCount}/${totalCount} enabled
            </span>
          </wa-button>
          <div class="provider-group-actions settings-disclosure-actions">
            ${providerKeyStatus}
          </div>
        </div>
        ${
          isExpanded
            ? html`
                <div class="provider-group-content settings-disclosure-content">
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
      </section>
    `;
  }

  private renderDeprecatedToggle(group: ProviderGroup): TemplateResult {
    const isOpen = this.expandedDeprecated.has(group.provider);

    return html`
      <wa-button
        class="deprecated-toggle"
        appearance="plain"
        size="s"
        aria-expanded=${String(isOpen)}
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
    // The pinned default (`DEFAULT_HELPER_MODEL`) is valid even when it is
    // not an enabled picker row. Keep it selectable so wa-select is not blank.
    const selectedHelper =
      this.helperModel !== '' &&
      !enabledModels.some((m) => m.name === this.helperModel)
        ? (this.models.find((m) => m.name === this.helperModel) ?? {
            name: this.helperModel,
            label: this.helperModel,
          })
        : undefined;
    const helperOptions = selectedHelper
      ? [selectedHelper, ...enabledModels]
      : enabledModels;

    return html`
      <div class="helper-model-row">
        <label for="helper-model-select">Model for quick fixes</label>
        <wa-select
          id="helper-model-select"
          class="helper-model-select form-control-fill"
          .value=${this.helperModel}
          @change=${this.handleHelperModelChange}
        >
          ${helperOptions.map(
            (m) => html`
              <wa-option value=${m.name}>
                ${m.label === m.name ? m.name : `${m.label} (${m.name})`}
              </wa-option>
            `,
          )}
        </wa-select>
        <span class="helper-model-help">
          Used for quick background jobs (e.g. intelligent merge).
        </span>
      </div>
    `;
  }

  override render(): TemplateResult {
    const groups = this.getProviderGroups();

    return html`
      <div class="model-selection-section">
        ${renderSettingsSectionHeading({
          title: 'Model selection',
          description:
            'Choose the models exposed to agents, plus the cheaper model used for quick background tasks.',
          icon: 'server',
        })}
        ${this.renderHelperModelDropdown()}
        <div class="short-names-toggle">
          <wa-switch
            ?checked=${this.preferShortModelNames}
            @change=${(e: Event) => {
              const enabled = (e.target as WaSwitch).checked;
              postStateSetting(
                GlobalStateKey.PREFER_SHORT_MODEL_NAMES,
                enabled,
              );
            }}
          >
            Use short model names
          </wa-switch>
          <span class="short-names-description">
            Send unpinned names (e.g. gpt-5.5 instead of gpt-5.5-2026-04-15)
          </span>
        </div>
        <div class="settings-disclosure-list">
          ${groups.map((g) => this.renderProviderGroup(g))}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'model-selection-list': ModelSelectionList;
  }
}
