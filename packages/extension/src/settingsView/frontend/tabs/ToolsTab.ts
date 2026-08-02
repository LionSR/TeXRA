/** Tool dashboard showing tool status and installation guides. */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
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

// Side-effect imports - register WA button, icon, and switch components
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';
import type WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';

// Side-effect: register tool card component
import '../components/tools/ToolCard';

/** Per-category display metadata. */
interface CategoryMeta {
  readonly label: string;
  readonly icon: TeXRAIconName;
}

/**
 * Single definition for category display metadata.
 * Record<ToolCategory, ...> ensures every category has an entry —
 * adding a new variant to ToolCategorySchema without an entry here
 * is a compile error.
 */
const CATEGORY_META: Record<ToolCategory, CategoryMeta> = {
  file: { label: 'File & Shell', icon: 'copy' },
  latex: { label: 'LaTeX', icon: 'file-code' },
  academic: { label: 'Academic Research', icon: 'graduation-cap' },
  web: { label: 'Web', icon: 'globe' },
  computation: { label: 'Computation', icon: 'cube' },
  lean: { label: 'Lean 4', icon: 'flask' },
  workflow: { label: 'Memory & Workflow', icon: 'diagram-project' },
  system: { label: 'System Dependencies', icon: 'gear' },
  // ai-agents lives on its own tab (AIAgentsTab); keep the meta entry so the
  // Record stays exhaustive and the type checker enforces it.
  'ai-agents': { label: 'Integrations', icon: 'robot' },
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

      .category-section {
        margin-bottom: var(--wa-space-s);
      }

      .setting-block {
        margin-bottom: var(--wa-space-2xs);
      }

      .setting-description {
        margin: var(--wa-space-3xs) 0 0 0;
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-quiet);
      }

      .tool-path-setting {
        margin-top: var(--wa-space-xs);
      }
    `,
  ];

  @property({ attribute: false }) items: ToolDashboardItem[] = [];
  @property({ type: Boolean }) loaded = false;
  @property({ type: Boolean }) bashApprovalEnabled = true;
  @property({ type: Boolean }) editApprovalEnabled = true;
  @property({ type: Boolean }) toolPathProtectionEnabled = true;
  @property({ type: Boolean }) agentSkillsEnabled = true;

  private handleRecheck(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.RECHECK_TOOL_STATUS);
  }

  private postStateToggle(key: string, e: Event): void {
    const target = e.target as WaSwitch | null;
    postMessage(SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING, {
      key,
      value: Boolean(target?.checked),
    });
  }

  private handleBashApprovalToggle = (e: Event): void => {
    this.postStateToggle(BASH_APPROVAL_CONFIG_KEY, e);
  };

  private handleEditApprovalToggle = (e: Event): void => {
    this.postStateToggle(TOOL_EDIT_APPROVAL_CONFIG_KEY, e);
  };

  private handleToolPathProtectionToggle = (e: Event): void => {
    this.postStateToggle(WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED, e);
  };

  private handleAgentSkillsToggle = (e: Event): void => {
    this.postStateToggle(AGENT_SKILLS_CONFIG_KEY, e);
  };

  /** Section holding a single labelled toggle. */
  private renderToggleSection(opts: {
    icon: TeXRAIconName;
    title: string;
    label: string;
    description: string;
    checked: boolean;
    onChange: (event: Event) => void;
  }): TemplateResult {
    return html`
      <div class="category-section">
        ${renderSettingsSectionHeading({ icon: opts.icon, title: opts.title })}
        <div class="settings-section">${this.renderToggleRow(opts)}</div>
      </div>
    `;
  }

  private renderToggleRow(opts: {
    label: string;
    description: string;
    checked: boolean;
    onChange: (event: Event) => void;
  }): TemplateResult {
    return html`
      <div class="settings-row">
        <div class="settings-row-text">
          <span class="settings-row-label">${opts.label}</span>
          <span class="settings-row-help">${opts.description}</span>
        </div>
        <wa-switch
          class="settings-row-control"
          aria-label=${opts.label}
          ?checked=${opts.checked}
          @change=${opts.onChange}
        ></wa-switch>
      </div>
    `;
  }

  private renderApprovalSettings(): TemplateResult {
    return html`
      <div class="category-section">
        ${renderSettingsSectionHeading({
          icon: 'shield',
          title: 'Approval & safety',
        })}
        <div class="settings-section">
          ${this.renderToggleRow({
            label: 'Approve workspace edits',
            description: 'Review a diff before an agent changes files.',
            checked: this.editApprovalEnabled,
            onChange: this.handleEditApprovalToggle,
          })}
          ${this.renderToggleRow({
            label: 'Approve shell commands',
            description: 'Pause before an agent runs a shell command.',
            checked: this.bashApprovalEnabled,
            onChange: this.handleBashApprovalToggle,
          })}
        </div>
      </div>
    `;
  }

  private renderAgentSkillsSettings(): TemplateResult {
    return this.renderToggleSection({
      icon: 'robot',
      title: 'Agent skills',
      label: 'Make skills available to tool-use agents',
      description: 'Includes built-in TeXRA skills and imported skills.',
      checked: this.agentSkillsEnabled,
      onChange: this.handleAgentSkillsToggle,
    });
  }

  private visibleItems(): ToolDashboardItem[] {
    return this.items.filter((item) => TOOLS_TAB_CATEGORIES.has(item.category));
  }

  private groupByCategory(
    items: readonly ToolDashboardItem[],
  ): Map<ToolCategory, ToolDashboardItem[]> {
    const groups = new Map<ToolCategory, ToolDashboardItem[]>();
    for (const item of items) {
      const list = groups.get(item.category) ?? [];
      list.push(item);
      groups.set(item.category, list);
    }
    return groups;
  }

  private renderSummary(
    items: readonly ToolDashboardItem[],
  ): TemplateResult | typeof nothing {
    if (items.length === 0) return nothing;

    let available = 0;
    for (const item of items) {
      if (item.status === 'available') available++;
    }

    const total = items.length;
    return html`<div class="tools-summary">
      ${waIcon('check')} ${available}/${total} available
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
                        <wa-switch
                          ?checked=${this.toolPathProtectionEnabled}
                          @change=${this.handleToolPathProtectionToggle}
                        >
                          Restrict tool paths to the working directory
                        </wa-switch>
                        <p class="setting-description">
                          When disabled, file, search, diagnostics, and PDF
                          tools may use arbitrary filesystem paths.
                        </p>
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
          ${renderLoadingState('Loading tool information...')}
        </div>
      `;
    }

    const items = this.visibleItems();
    const groups = this.groupByCategory(items);

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
