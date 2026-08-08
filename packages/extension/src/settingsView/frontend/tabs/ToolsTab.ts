/** Tool dashboard showing tool status and installation guides. */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import {
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  TEXRA_APPROVAL_POLICY_OPTIONS,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import { BASH_APPROVAL_CONFIG_KEY } from '@shared/schemas';
import { AGENT_SKILLS_CONFIG_KEY } from '@shared/schemas/agentSkills';
import { TOOL_EDIT_APPROVAL_CONFIG_KEY } from '@shared/schemas/coreSettings';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { renderLoadingState } from '@shared/wa/loadingState';
import { renderSettingsSectionHeading } from '@shared/wa/settingsSection';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Local imports - shared schemas
import type {
  ToolDashboardItem,
  ToolCategory,
} from '@shared/schemas/settingsViewMessages';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { groupBy } from '@utils/core';

// Side-effect imports - register WA button, icon, and switch components
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';

// Local imports - catalog-driven settings rows
import {
  postStateSetting,
  renderStateSettingToggleRow,
} from '../components/shared/stateSettingRows';
import type WaSelect from '@awesome.me/webawesome/dist/components/select/select.js';

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
  // ai-agents lives on its own tab (AIAgentsTab); keep the meta entry so the
  // Record stays exhaustive and the type checker enforces it.
  'ai-agents': {
    label: 'Integrations',
    description: 'Coding agents and external integrations.',
    icon: 'robot',
  },
};

/** Canonical category display order. The 'ai-agents' category is rendered by
 * the dedicated AIAgentsTab, so it is intentionally omitted here. */
const CATEGORY_ORDER: ToolCategory[] = [
  'file',
  'latex',
  'academic',
  'web',
  'computation',
  'lean',
  'workflow',
  'system',
];
const TOOLS_TAB_CATEGORIES = new Set<ToolCategory>(CATEGORY_ORDER);

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
    `,
  ];

  @property({ attribute: false }) items: ToolDashboardItem[] = [];
  @property({ type: Boolean }) loaded = false;
  @property({ type: String }) approvalPolicy: TexraApprovalPolicy = 'ask';
  @property({ type: Boolean }) bashApprovalEnabled = true;
  @property({ type: Boolean }) editApprovalEnabled = true;
  @property({ type: Boolean }) toolPathProtectionEnabled = true;
  @property({ type: Boolean }) agentSkillsEnabled = true;

  private handleRecheck(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.RECHECK_TOOL_STATUS);
  }

  private handleApprovalPolicyChange = (e: Event): void => {
    const target = e.target as WaSelect | null;
    const value = target?.value;
    if (value !== 'ask' && value !== 'never' && value !== 'yolo') {
      return;
    }
    postStateSetting(TEXRA_APPROVAL_POLICY_CONFIG_KEY, value);
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
            <label class="setting-label" for="texra-approval-policy">
              Approval policy
            </label>
            <wa-select
              id="texra-approval-policy"
              value=${this.approvalPolicy}
              class="setting-enum-select"
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
          ${renderStateSettingToggleRow({
            key: TOOL_EDIT_APPROVAL_CONFIG_KEY,
            label: 'Under Ask: require approval for file edits',
            description:
              'When policy is Ask, review a diff before an agent changes files. Inert under Never and Auto-approve.',
            checked: this.editApprovalEnabled,
          })}
          ${renderStateSettingToggleRow({
            key: BASH_APPROVAL_CONFIG_KEY,
            label: 'Under Ask: require approval for shell commands',
            description:
              'When policy is Ask, pause before an agent runs a shell command. Inert under Never and Auto-approve.',
            checked: this.bashApprovalEnabled,
          })}
        </div>
      </div>
    `;
  }

  private renderAgentSkillsSettings(): TemplateResult {
    return html`
      <div class="category-section">
        ${renderSettingsSectionHeading({
          icon: 'robot',
          title: 'Agent skills',
          description: 'Extend tool-use agents with reusable skill packages.',
        })}
        <div class="settings-section">
          ${renderStateSettingToggleRow({
            key: AGENT_SKILLS_CONFIG_KEY,
            label: 'Make skills available to tool-use agents',
            description: 'Includes built-in TeXRA skills and imported skills.',
            checked: this.agentSkillsEnabled,
          })}
        </div>
      </div>
    `;
  }

  private visibleItems(): ToolDashboardItem[] {
    return this.items.filter((item) => TOOLS_TAB_CATEGORIES.has(item.category));
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
              ${
                item.id === 'file-ops'
                  ? html`
                      <div
                        slot="details"
                        class="setting-block tool-path-setting"
                      >
                        ${renderStateSettingToggleRow({
                          key: WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
                          label: 'Restrict tool paths to the working directory',
                          description:
                            'Keep file, search, diagnostics, and PDF tools inside the working directory.',
                          checked: this.toolPathProtectionEnabled,
                        })}
                      </div>
                    `
                  : nothing
              }
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

    const items = this.visibleItems();
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
            onClick: () => this.handleRecheck(),
          })}
        </div>
        ${this.renderAgentSkillsSettings()} ${this.renderApprovalSettings()}
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
