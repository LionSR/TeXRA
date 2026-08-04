/**
 * Integrations tab for coding agents, services, reference managers, and
 * assisted inquiries. Reuses the same `tool-card` component as the Tools tab,
 * plus the Codex-specific inline settings that used to live inside ToolsTab.
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
import { renderEmptyState } from '@shared/wa/emptyState';
import { renderLoadingState } from '@shared/wa/loadingState';

// Local imports - shared schemas
import type {
  ToolDashboardItem,
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
import { readSelectValue } from '@shared/utils/selectTemplates';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';

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

      .ai-agents-status {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--wa-space-s);
        margin-bottom: var(--wa-space-xs);
        font-size: var(--font-size-sm);
      }

      .ai-agents-status-stat {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        white-space: nowrap;
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

  private renderSelectRow(
    label: string,
    key: WorkspaceStateKey,
    value: string,
    options: readonly { value: string; label: string }[],
  ): TemplateResult {
    const onChange = (e: Event): void => {
      const selected = readSelectValue(e);
      if (selected) {
        postMessage(SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING, {
          key,
          value: selected,
        });
      }
    };
    return html`
      <div class="settings-row">
        <div class="settings-row-text">
          <span class="settings-row-label">${label}</span>
          <span class="settings-row-help">
            Applied whenever this integration runs.
          </span>
        </div>
        <div class="settings-row-control">
          <wa-select
            class="setting-select"
            aria-label=${label}
            .value=${value}
            @change=${onChange}
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

  private renderCodexInlineSettings(): TemplateResult {
    return html`
      <div class="settings-section">
        ${this.renderSelectRow(
          'Sandbox mode',
          WorkspaceStateKey.CODEX_SANDBOX_MODE,
          this.codexSandboxMode,
          SANDBOX_MODE_OPTIONS,
        )}
        ${this.renderSelectRow(
          'Reasoning effort',
          WorkspaceStateKey.CODEX_REASONING_EFFORT,
          this.codexReasoningEffort,
          REASONING_EFFORT_OPTIONS,
        )}
        ${this.renderSelectRow(
          'Approval policy',
          WorkspaceStateKey.CODEX_APPROVAL_POLICY,
          this.codexApprovalPolicy,
          APPROVAL_POLICY_OPTIONS,
        )}
      </div>
    `;
  }

  private renderClaudeAgentInlineSettings(): TemplateResult {
    return html`
      <div class="settings-section">
        ${this.renderSelectRow(
          'Model',
          WorkspaceStateKey.CLAUDE_AGENT_MODEL,
          this.claudeAgentModel,
          CLAUDE_MODEL_OPTIONS,
        )}
        ${this.renderSelectRow(
          'Reasoning effort',
          WorkspaceStateKey.CLAUDE_AGENT_EFFORT,
          this.claudeAgentEffort,
          CLAUDE_EFFORT_OPTIONS,
        )}
        ${this.renderSelectRow(
          'Permission mode',
          WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE,
          this.claudeAgentPermissionMode,
          CLAUDE_PERMISSION_MODE_OPTIONS,
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

  private renderStatusSummary(
    items: readonly ToolDashboardItem[],
  ): TemplateResult {
    const counts: Record<ToolDashboardItem['status'], number> = {
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
                  ${waIcon('triangle-exclamation')} ${counts['not-found']} need
                  setup
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
        ${
          items.length === 0
            ? renderEmptyState({
                icon: 'robot',
                title: 'No integrations registered.',
                body: 'Coding agents and services appear here once TeXRA detects them.',
                headingTag: 'h3',
                className: 'empty-state',
              })
            : html`
                ${this.renderStatusSummary(items)}
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
