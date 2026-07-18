/**
 * AI Agents tab — shows third-party agent integrations (Codex, Claude Code,
 * external inquiries) grouped on their own panel. Reuses the same
 * `tool-card` component as the Tools tab, plus the Codex-specific inline
 * settings that used to live inside ToolsTab.
 */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { renderLoadingState } from '@shared/wa/loadingState';

// Local imports - shared schemas
import type {
  ToolDashboardItem,
  ToolStatus,
  CodexSandboxMode,
  CodexReasoningEffort,
  CodexApprovalPolicy,
  ClaudeAgentEffort,
  ClaudeAgentModel,
  ClaudeAgentPermissionMode,
} from '@shared/schemas/settingsViewMessages';
import {
  settingEnumChoices,
  stateSettingByKey,
} from '@shared/schemas/stateSettings';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { CLAUDE_AGENT_DEFAULT_MODEL } from '@shared/schemas/agentCliSettings';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import type WaSelect from '@awesome.me/webawesome/dist/components/select/select.js';

// Side-effect: register tool card component
import '../components/tools/ToolCard';

function catalogSelectOptions<T extends string>(
  key: WorkspaceStateKey,
): readonly { value: T; label: string }[] {
  const entry = stateSettingByKey(key);
  return entry ? (settingEnumChoices<T>(entry) ?? []) : [];
}

const SANDBOX_MODE_OPTIONS = catalogSelectOptions<CodexSandboxMode>(
  WorkspaceStateKey.CODEX_SANDBOX_MODE,
);
const REASONING_EFFORT_OPTIONS = catalogSelectOptions<CodexReasoningEffort>(
  WorkspaceStateKey.CODEX_REASONING_EFFORT,
);
const APPROVAL_POLICY_OPTIONS = catalogSelectOptions<CodexApprovalPolicy>(
  WorkspaceStateKey.CODEX_APPROVAL_POLICY,
);
const CLAUDE_MODEL_OPTIONS = catalogSelectOptions<ClaudeAgentModel>(
  WorkspaceStateKey.CLAUDE_AGENT_MODEL,
);
const CLAUDE_PERMISSION_MODE_OPTIONS =
  catalogSelectOptions<ClaudeAgentPermissionMode>(
    WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE,
  );
const CLAUDE_EFFORT_OPTIONS = catalogSelectOptions<ClaudeAgentEffort>(
  WorkspaceStateKey.CLAUDE_AGENT_EFFORT,
);

@customElement('ai-agents-tab')
export class AIAgentsTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .ai-agents-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--wa-space-xs);
        margin-bottom: var(--wa-space-xs);
      }

      .ai-agents-intro {
        margin: 0;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        line-height: var(--line-height-normal);
      }

      .ai-agents-empty {
        padding: var(--wa-space-l);
        text-align: center;
        color: var(--wa-color-text-quiet);
        font-size: var(--font-size-sm);
      }

      .ai-agents-status {
        display: flex;
        align-items: center;
        gap: var(--wa-space-s);
        font-size: var(--font-size-sm);
        white-space: nowrap;
      }

      .ai-agents-status-stat {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
      }

      .ai-agents-status-stat wa-icon {
        font-size: var(--font-size-sm);
      }

      .ai-agents-status-available {
        color: var(--color-status-ok);
      }

      .ai-agents-status-missing {
        color: var(--color-status-error);
      }

      .ai-agents-status-neutral {
        color: var(--wa-color-text-quiet);
      }

      .category-section {
        margin-bottom: var(--wa-space-m);
      }

      .agent-inline-settings {
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        margin-bottom: var(--wa-space-2xs);
        border-radius: var(--border-radius);
        background: var(--wa-color-surface-lowered);
      }

      .setting-row {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        min-height: 24px;
      }

      .setting-row label {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        white-space: nowrap;
      }

      .setting-select {
        min-width: 10rem;
        max-width: 14rem;
      }
    `,
  ];

  @property({ attribute: false }) items: ToolDashboardItem[] = [];
  @property({ type: Boolean }) loaded = false;
  @property({ type: String }) codexSandboxMode = 'workspace-write';
  @property({ type: String }) codexReasoningEffort = 'high';
  @property({ type: String }) codexApprovalPolicy = 'never';
  @property({ type: String }) claudeAgentModel: ClaudeAgentModel =
    CLAUDE_AGENT_DEFAULT_MODEL;
  @property({ type: String })
  claudeAgentPermissionMode: ClaudeAgentPermissionMode = 'acceptEdits';
  @property({ type: String }) claudeAgentEffort: ClaudeAgentEffort = 'high';

  private postSelect(command: string, key: string, e: Event): void {
    const select = e.currentTarget as WaSelect | null;
    const value = typeof select?.value === 'string' ? select.value : '';
    if (value) {
      postMessage(command, { [key]: value });
    }
  }

  private renderSelectRow(
    label: string,
    value: string,
    options: readonly { value: string; label: string }[],
    onChange: (e: Event) => void,
  ): TemplateResult {
    return html`
      <div class="setting-row">
        <label>${label}</label>
        <wa-select class="setting-select" .value=${value} @change=${onChange}>
          ${options.map(
            (opt) => html`
              <wa-option value=${opt.value}>${opt.label}</wa-option>
            `,
          )}
        </wa-select>
      </div>
    `;
  }

  private renderCodexInlineSettings(): TemplateResult {
    return html`
      <div class="agent-inline-settings">
        ${this.renderSelectRow(
          'Sandbox mode',
          this.codexSandboxMode,
          SANDBOX_MODE_OPTIONS,
          (e) =>
            this.postSelect(
              SETTINGS_VIEW_COMMANDS.SET_CODEX_SANDBOX_MODE,
              'mode',
              e,
            ),
        )}
        ${this.renderSelectRow(
          'Reasoning effort',
          this.codexReasoningEffort,
          REASONING_EFFORT_OPTIONS,
          (e) =>
            this.postSelect(
              SETTINGS_VIEW_COMMANDS.SET_CODEX_REASONING_EFFORT,
              'effort',
              e,
            ),
        )}
        ${this.renderSelectRow(
          'Approval policy',
          this.codexApprovalPolicy,
          APPROVAL_POLICY_OPTIONS,
          (e) =>
            this.postSelect(
              SETTINGS_VIEW_COMMANDS.SET_CODEX_APPROVAL_POLICY,
              'policy',
              e,
            ),
        )}
      </div>
    `;
  }

  private renderClaudeAgentInlineSettings(): TemplateResult {
    return html`
      <div class="agent-inline-settings">
        ${this.renderSelectRow(
          'Model',
          this.claudeAgentModel,
          CLAUDE_MODEL_OPTIONS,
          (e) =>
            this.postSelect(
              SETTINGS_VIEW_COMMANDS.SET_CLAUDE_AGENT_MODEL,
              'model',
              e,
            ),
        )}
        ${this.renderSelectRow(
          'Reasoning effort',
          this.claudeAgentEffort,
          CLAUDE_EFFORT_OPTIONS,
          (e) =>
            this.postSelect(
              SETTINGS_VIEW_COMMANDS.SET_CLAUDE_AGENT_EFFORT,
              'effort',
              e,
            ),
        )}
        ${this.renderSelectRow(
          'Permission mode',
          this.claudeAgentPermissionMode,
          CLAUDE_PERMISSION_MODE_OPTIONS,
          (e) =>
            this.postSelect(
              SETTINGS_VIEW_COMMANDS.SET_CLAUDE_AGENT_PERMISSION_MODE,
              'mode',
              e,
            ),
        )}
      </div>
    `;
  }

  private renderInlineSettingsFor(itemId: string): TemplateResult | null {
    if (itemId === 'codex') return this.renderCodexInlineSettings();
    if (itemId === 'claude-agent')
      return this.renderClaudeAgentInlineSettings();
    return null;
  }

  private aiAgentItems(): ToolDashboardItem[] {
    return this.items.filter((item) => item.category === 'ai-agents');
  }

  /**
   * Read-only status summary derived from the same `toolDashboardItems`
   * signal the Tools tab uses to drive its actionable "Re-check" button.
   * This tab only reflects that shared state — the Tools tab owns the one
   * control that re-runs the probe (see AGENTS.md "UI anti-patterns" (Duplicate UI controls)).
   */
  private renderStatusSummary(
    items: readonly ToolDashboardItem[],
  ): TemplateResult | typeof nothing {
    if (items.length === 0) return nothing;

    const counts: Record<ToolStatus, number> = {
      available: 0,
      'not-found': 0,
      unknown: 0,
      'coming-soon': 0,
    };
    for (const item of items) {
      counts[item.status] += 1;
    }
    const pending = counts.unknown + counts['coming-soon'];

    return html`
      <div class="ai-agents-status">
        <span class="ai-agents-status-stat ai-agents-status-available">
          ${waIcon('check')} ${counts.available} available
        </span>
        ${
          counts['not-found'] > 0
            ? html`
                <span class="ai-agents-status-stat ai-agents-status-missing">
                  ${waIcon('warning')} ${counts['not-found']} need setup
                </span>
              `
            : nothing
        }
        ${
          pending > 0
            ? html`
                <span class="ai-agents-status-stat ai-agents-status-neutral">
                  ${waIcon('clock')} ${pending} pending
                </span>
              `
            : nothing
        }
      </div>
    `;
  }

  override render(): TemplateResult {
    if (!this.loaded) {
      return html`
        <div class="tab-content-container">
          ${renderLoadingState('Loading integrations…')}
        </div>
      `;
    }

    const items = this.aiAgentItems();

    return html`
      <div class="tab-content-container">
        <div class="ai-agents-header">
          <p class="ai-agents-intro">
            Connect external tools and services that TeXRA can call from agent
            runs, such as coding agents, GitHub, and reference managers. Each
            integration shows its own setup and authentication state here.
          </p>
          ${this.renderStatusSummary(items)}
        </div>

        ${
          items.length === 0
            ? html`<div class="ai-agents-empty">
                No integrations registered.
              </div>`
            : html`
                <div class="category-section">
                  ${repeat(
                    items,
                    (item) => item.id,
                    (item) => {
                      const inlineSettings = this.renderInlineSettingsFor(
                        item.id,
                      );
                      return html`
                        <tool-card .item=${item}>
                          ${
                            inlineSettings
                              ? html`<div slot="details">
                                  ${inlineSettings}
                                </div>`
                              : nothing
                          }
                        </tool-card>
                      `;
                    },
                  )}
                </div>
              `
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ai-agents-tab': AIAgentsTab;
  }
}
