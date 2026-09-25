/**
 * The Tools page: approval policy, then every tool and integration with its
 * status and setup guide, plus the inline settings rows each card's plugin
 * declares (Codex and Claude Code today).
 */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles, ipc, and schemas
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import {
  parseTexraApprovalPolicy,
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  TEXRA_APPROVAL_POLICY_OPTIONS,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  BASH_APPROVAL_CONFIG_KEY,
  TOOL_EDIT_APPROVAL_CONFIG_KEY,
} from '@shared/schemas';
import { settingsViewSettingByKey } from '@shared/state/stateSettings';
import {
  type ToolCategory,
  type ToolDashboardItem,
} from '@shared/settingsView/settingsViewMessages';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { commonViewStyles, designTokens } from '@ui/styles';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { renderLoadingState } from '@ui/wa/loadingState';
import { renderSettingsSectionHeading } from '@ui/wa/settingsSection';
import type { TeXRAIconName } from '@ui/wa/iconNames';
import { waIcon } from '@ui/wa/webAwesomeIcons';

// Local imports - shared state keys and utilities
import { readSelectValue } from '@ui/wa/selectTemplates';
import { groupBy } from '@utils/core';

// Side-effect imports - register WA button, icon, select, and option components
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';

// Local imports - catalog-driven settings rows
import {
  catalogEnumChoices,
  postStateSetting,
  renderStateSettingToggleRow,
} from '../components/shared/stateSettingRows';

// Side-effect: register tool card component
import '../components/tools/ToolCard';

/** Per-category display metadata. */
interface CategoryMeta {
  readonly label: string;
  readonly description: string;
  readonly icon: TeXRAIconName;
}

/**
 * Single definition for category display metadata.
 * Record<ToolCategory, ...> ensures every category has an entry —
 * adding a new variant to ToolCategorySchema without an entry here
 * is a compile error.
 */
const CATEGORY_META: Record<ToolCategory, CategoryMeta> = {
  file: {
    label: 'File & shell',
    description: 'Read, edit, search, and run commands in the workspace.',
    icon: 'copy',
  },
  latex: {
    label: 'LaTeX',
    description: 'Compile, diff, and format LaTeX documents.',
    icon: 'file-code',
  },
  academic: {
    label: 'Academic research',
    description: 'Search papers and manage academic references.',
    icon: 'graduation-cap',
  },
  web: {
    label: 'Web',
    description: 'Search the web and fetch page content.',
    icon: 'globe',
  },
  computation: {
    label: 'Computation',
    description: 'Evaluate math and run computations.',
    icon: 'cube',
  },
  lean: {
    label: 'Lean 4',
    description: 'Work with the Lean 4 proof assistant.',
    icon: 'flask',
  },
  workflow: {
    label: 'Memory & workflow',
    description: 'Remember context and track work across sessions.',
    icon: 'diagram-project',
  },
  system: {
    label: 'System dependencies',
    description: 'External runtimes that other tools depend on.',
    icon: 'gear',
  },
  'ai-agents': {
    label: 'Integrations',
    description:
      'Coding agents, reference managers, GitHub activity, and other services.',
    icon: 'link',
  },
};

/** Canonical category display order. */
const CATEGORY_ORDER: readonly ToolCategory[] = [
  'file',
  'latex',
  'academic',
  'web',
  'computation',
  'lean',
  'workflow',
  'ai-agents',
  'system',
];

@customElement('tools-tab')
export class ToolsTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .tools-summary {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        font-size: var(--font-size-sm);
        color: var(--color-status-ok);
      }

      .tools-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--wa-space-s);
        margin-bottom: var(--wa-space-xs);
      }

      .setting-block {
        margin-bottom: var(--wa-space-2xs);
      }

      .tool-path-setting {
        margin-top: var(--wa-space-xs);
      }

      .setting-select {
        min-width: 10rem;
        max-width: 14rem;
      }
    `,
  ];

  @property({ attribute: false }) items: ToolDashboardItem[] = [];
  @property({ type: Boolean }) loaded = false;
  @property({ type: String }) approvalPolicy: TexraApprovalPolicy = 'ask';
  @property({ type: Boolean }) bashApprovalEnabled = true;
  @property({ type: Boolean }) editApprovalEnabled = true;
  @property({ type: Boolean }) toolPathProtectionEnabled = true;
  /** Current value of every inline setting the cards declare, by catalog
   *  key; `SettingsApp` reads them from the keyed setting signals. */
  @property({ attribute: false }) settingValues: Readonly<
    Record<string, string>
  > = {};

  private handleApprovalPolicyChange = (e: Event): void => {
    const policy = parseTexraApprovalPolicy(readSelectValue(e));
    if (policy) postStateSetting(TEXRA_APPROVAL_POLICY_CONFIG_KEY, policy);
  };

  private renderApprovalSettings(): TemplateResult {
    return html`
      <div class="category-section">
        ${renderSettingsSectionHeading({
          icon: 'shield',
          title: 'Approval & safety',
          description: 'Choose when agents pause for approval before acting.',
        })}
        <div class="settings-section">
          <div class="setting-block">
            <label class="settings-row-label" for="texra-approval-policy">
              Approval policy
            </label>
            <wa-select
              id="texra-approval-policy"
              value=${this.approvalPolicy}
              @change=${this.handleApprovalPolicyChange}
            >
              ${TEXRA_APPROVAL_POLICY_OPTIONS.map(
                (option) => html`
                  <wa-option value=${option.value}
                    >${option.label} — ${option.description}</wa-option
                  >
                `,
              )}
            </wa-select>
          </div>
          ${
            // The two switches refine Ask only (decideTexraApproval ignores
            // them under Never and Auto-approve), so they show only then.
            this.approvalPolicy === 'ask'
              ? html`
                  ${renderStateSettingToggleRow({
                    key: TOOL_EDIT_APPROVAL_CONFIG_KEY,
                    checked: this.editApprovalEnabled,
                  })}
                  ${renderStateSettingToggleRow({
                    key: BASH_APPROVAL_CONFIG_KEY,
                    checked: this.bashApprovalEnabled,
                  })}
                `
              : nothing
          }
        </div>
      </div>
    `;
  }

  /**
   * One catalog-backed select row: the allowed values, their labels, and the
   * help text all come from the `stateSettings` entry for `key`, and the
   * change handler writes that same key. Only the row label is passed in —
   * inside an integration card it reads bare ('Reasoning effort') where the
   * catalog title has to disambiguate in a flat list ('Codex reasoning
   * effort').
   */
  private renderSelectRow(
    label: string,
    key: string,
    value: string,
  ): TemplateResult {
    const entry = settingsViewSettingByKey(key);
    if (!entry) {
      throw new Error(`No settings-view catalog row for setting "${key}"`);
    }
    const options = catalogEnumChoices(key);
    if (options.length === 0) {
      throw new Error(`Inline setting "${key}" is not an enum catalog row`);
    }
    const controlId = `ai-agent-${key.replaceAll('.', '-')}`;
    return html`
      <div class="settings-row">
        <div class="settings-row-text">
          <label class="settings-row-label" for=${controlId}>${label}</label>
          <span class="settings-row-help">${entry.description}</span>
        </div>
        <div class="settings-row-control">
          <wa-select
            class="setting-select"
            id=${controlId}
            .value=${value}
            @change=${(e: Event) => {
              const selected = readSelectValue(e);
              if (selected) postStateSetting(key, selected);
            }}
          >
            ${options.map(
              (opt) => html`
                <wa-option value=${opt.value}>${opt.label}</wa-option>
              `,
            )}
          </wa-select>
        </div>
      </div>
    `;
  }

  /** The per-card settings: path protection, and each plugin's own rows. */
  private renderCardSettings(
    item: ToolDashboardItem,
  ): TemplateResult | typeof nothing {
    if (item.id === 'file-ops') {
      return html`
        <div slot="details" class="setting-block tool-path-setting">
          ${renderStateSettingToggleRow({
            key: WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
            checked: this.toolPathProtectionEnabled,
          })}
        </div>
      `;
    }
    if (!item.settings?.length) return nothing;
    return html`
      <div slot="details" class="settings-section">
        ${item.settings.map(([key, label]) =>
          this.renderSelectRow(label, key, this.settingValues[key]),
        )}
      </div>
    `;
  }

  private renderSummary(
    items: readonly ToolDashboardItem[],
  ): TemplateResult | typeof nothing {
    if (items.length === 0) return nothing;

    const available = items.filter(
      (item) => item.status === 'available',
    ).length;
    return html`<div class="tools-summary">
      ${waIcon('check')} ${available}/${items.length} available
    </div>`;
  }

  private renderCategory(
    category: ToolCategory,
    items: ToolDashboardItem[],
  ): TemplateResult {
    const meta = CATEGORY_META[category];
    return html`
      <div class="category-section">
        ${renderSettingsSectionHeading({
          icon: meta.icon,
          title: `${meta.label} (${items.length})`,
          description: meta.description,
        })}
        ${repeat(
          items,
          (item) => item.id,
          (item) => html`
            <tool-card .item=${item}>
              ${this.renderCardSettings(item)}
            </tool-card>
          `,
        )}
      </div>
    `;
  }

  override render(): TemplateResult {
    if (!this.loaded) {
      return html`
        <div class="tools-container tab-content-container">
          ${renderLoadingState('Loading tool information…')}
        </div>
      `;
    }

    const items = this.items;
    const groups = groupBy(items, (i) => i.category);

    return html`
      <div class="tools-container tab-content-container">
        <div class="tools-toolbar">
          ${this.renderSummary(items)}
          ${renderLabeledActionButton({
            icon: 'rotate-right',
            text: 'Re-check',
            kind: 'secondary',
            appearance: 'outlined',
            onClick: () =>
              postMessage(SETTINGS_VIEW_COMMANDS.RECHECK_TOOL_STATUS),
          })}
        </div>
        ${this.renderApprovalSettings()}
        ${CATEGORY_ORDER.flatMap((cat) => {
          const catItems = groups.get(cat);
          return catItems ? [this.renderCategory(cat, catItems)] : [];
        })}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'tools-tab': ToolsTab;
  }
}
