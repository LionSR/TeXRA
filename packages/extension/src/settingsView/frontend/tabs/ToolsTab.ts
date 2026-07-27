/** Tool dashboard showing tool status and installation guides. */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import '@awesome.me/webawesome/dist/components/progress-ring/progress-ring.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import {
  commonViewStyles,
  designTokens,
  settingsBannerStyles,
} from '@shared/styles';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { renderLoadingState } from '@shared/wa/loadingState';
import { renderSettingsBanner } from '@shared/wa/settingsBanner';
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
    settingsBannerStyles,
    css`
      :host {
        display: block;
      }

      /* max-width and centering provided by .tab-content-container */

      .tools-summary {
        display: flex;
        align-items: center;
        gap: var(--wa-space-s);
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .tools-health-ring {
        display: flex;
        align-items: center;
        gap: var(--wa-space-xs);
      }

      .tools-health-ring wa-progress-ring {
        --size: 36px;
        --track-width: 4px;
        --track-color: var(--wa-color-surface-border);
        --indicator-color: var(--color-status-ok);
      }

      .tools-health-labels {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-3xs);
      }

      .tools-summary-stat {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
      }

      .tools-summary-stat wa-icon {
        font-size: var(--font-size-sm);
      }

      .tools-stat-available {
        color: var(--color-status-ok);
      }

      .tools-stat-missing {
        color: var(--color-status-error);
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
  @property({ type: Boolean }) toolPathProtectionEnabled = true;
  @property({ type: Boolean }) agentSkillsEnabled = true;
  @property({ attribute: false }) showAgentSkillsSettings = false;
  @property({ attribute: false }) showDesktopCrashReporting = false;
  @property({ attribute: false }) desktopCrashReportingEnabled = false;
  @property({ attribute: false }) desktopCrashReportingConfigured = false;

  private handleRecheck(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.RECHECK_TOOL_STATUS);
  }

  private postToggle(command: string, e: Event): void {
    const target = e.target as WaSwitch | null;
    postMessage(command, { enabled: Boolean(target?.checked) });
  }

  private handleBashApprovalToggle = (e: Event): void => {
    this.postToggle(SETTINGS_VIEW_COMMANDS.SET_BASH_APPROVAL_ENABLED, e);
  };

  private handleToolPathProtectionToggle = (e: Event): void => {
    const target = e.target as WaSwitch | null;
    postMessage(SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING, {
      key: WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
      value: Boolean(target?.checked),
    });
  };

  private handleAgentSkillsToggle = (e: Event): void => {
    this.postToggle(SETTINGS_VIEW_COMMANDS.SET_AGENT_SKILLS_ENABLED, e);
  };

  private handleDesktopCrashReportingToggle = (e: Event): void => {
    this.postToggle(
      SETTINGS_VIEW_COMMANDS.SET_DESKTOP_CRASH_REPORTING_ENABLED,
      e,
    );
  };

  private handleSetDesktopCrashReportingDsn = (): void => {
    postMessage(SETTINGS_VIEW_COMMANDS.SET_DESKTOP_CRASH_REPORTING_DSN);
  };

  private renderApprovalSettings(): TemplateResult {
    return html`
      <div class="category-section">
        ${renderSettingsSectionHeading({
          icon: 'shield',
          title: 'Approval & safety',
        })}
        <div class="settings-section">
          <div class="settings-row">
            <div class="settings-row-text">
              <span class="settings-row-label">
                Require approval for shell commands and agent sessions
              </span>
              <span class="settings-row-help">
                Pause before potentially consequential local actions.
              </span>
            </div>
            <wa-switch
              class="settings-row-control"
              aria-label="Require approval for shell commands and agent sessions"
              ?checked=${this.bashApprovalEnabled}
              @change=${this.handleBashApprovalToggle}
            ></wa-switch>
          </div>
        </div>
      </div>
    `;
  }

  private renderAgentSkillsSettings(): TemplateResult | typeof nothing {
    if (!this.showAgentSkillsSettings) return nothing;
    return html`
      <div class="category-section">
        ${renderSettingsSectionHeading({
          icon: 'robot',
          title: 'Agent skills',
        })}
        <div class="settings-section">
          <div class="settings-row">
            <div class="settings-row-text">
              <span class="settings-row-label">
                Make skills available to tool-use agents
              </span>
              <span class="settings-row-help">
                Includes built-in TeXRA skills and imported skills.
              </span>
            </div>
            <wa-switch
              class="settings-row-control"
              aria-label="Make skills available to tool-use agents"
              ?checked=${this.agentSkillsEnabled}
              @change=${this.handleAgentSkillsToggle}
            ></wa-switch>
          </div>
        </div>
      </div>
    `;
  }

  private renderDesktopCrashReporting(): TemplateResult | typeof nothing {
    if (!this.showDesktopCrashReporting) return nothing;
    return html`
      <div class="category-section">
        ${renderSettingsSectionHeading({
          icon: 'download',
          title: 'Desktop diagnostics',
        })}
        <div class="settings-section">
          <div class="settings-row">
            <div class="settings-row-text">
              <span class="settings-row-label">Native crash reporting</span>
              <span class="settings-row-help">
                Opt-in native crash capture. Reports are scrubbed before upload
                and performance tracing stays disabled.
              </span>
            </div>
            <div class="settings-row-control action-button-group">
              <wa-switch
                aria-label="Enable native crash reporting"
                ?checked=${this.desktopCrashReportingEnabled}
                @change=${this.handleDesktopCrashReportingToggle}
              ></wa-switch>
              <wa-tag
                variant=${
                  this.desktopCrashReportingConfigured
                    ? 'success'
                    : 'triangle-exclamation'
                }
                size="s"
              >
                ${
                  this.desktopCrashReportingConfigured
                    ? 'DSN set'
                    : 'DSN missing'
                }
              </wa-tag>
              ${renderLabeledActionButton({
                icon: 'key',
                text: this.desktopCrashReportingConfigured
                  ? 'Replace DSN'
                  : 'Set DSN',
                kind: 'secondary',
                appearance: 'outlined',
                onClick: this.handleSetDesktopCrashReportingDsn,
              })}
            </div>
          </div>
        </div>
      </div>
    `;
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
    let missing = 0;
    for (const item of items) {
      if (item.status === 'available') available++;
      else if (item.status === 'not-found') missing++;
    }

    const total = items.length;
    const availablePercent = (available / total) * 100;
    const availabilityLabel = `${available} of ${total} tools available`;

    return html`
      <div class="tools-summary">
        <div class="tools-health-ring">
          <wa-progress-ring
            .value=${availablePercent}
            .label=${availabilityLabel}
          ></wa-progress-ring>
          <div class="tools-health-labels">
            <span class="tools-summary-stat tools-stat-available">
              ${waIcon('check')} ${available} available
            </span>
            ${
              missing > 0
                ? html`
                    <span class="tools-summary-stat tools-stat-missing">
                      ${waIcon('triangle-exclamation')} ${missing} need setup
                    </span>
                  `
                : nothing
            }
          </div>
        </div>
      </div>
    `;
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
        ${renderSettingsBanner({
          id: 'tool-availability-banner',
          icon: 'screwdriver-wrench',
          title: 'Tool availability',
          description:
            'Monitor local capabilities and configure the tools agents may use.',
          detail: this.renderSummary(items),
          actions: renderLabeledActionButton({
            icon: 'rotate-right',
            text: 'Re-check',
            kind: 'secondary',
            appearance: 'outlined',
            onClick: () => this.handleRecheck(),
          }),
        })}
        ${this.renderAgentSkillsSettings()} ${this.renderApprovalSettings()}
        ${this.renderDesktopCrashReporting()}
        ${CATEGORY_ORDER.filter((cat) => groups.has(cat)).map((cat) =>
          this.renderCategory(cat, groups.get(cat)!),
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'tools-tab': ToolsTab;
  }
}
