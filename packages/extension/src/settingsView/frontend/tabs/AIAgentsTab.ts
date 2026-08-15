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
import type {
  ClaudeAgentEffort,
  ClaudeAgentModel,
  ClaudeAgentPermissionMode,
  CodexApprovalPolicy,
  CodexReasoningEffort,
  CodexSandboxMode,
  ToolDashboardItem,
} from '@shared/schemas';
import {
  CLAUDE_AGENT_DEFAULT_EFFORT,
  CLAUDE_AGENT_DEFAULT_MODEL,
  CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
  CODEX_APPROVAL_POLICY_DEFAULT,
  CODEX_REASONING_EFFORT_DEFAULT,
  CODEX_SANDBOX_MODE_DEFAULT,
} from '@shared/schemas';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { renderEmptyState } from '@shared/wa/emptyState';
import { renderLoadingState } from '@shared/wa/loadingState';

// Local imports - shared schemas
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { readSelectValue } from '@shared/utils/selectTemplates';

// Local imports - catalog-driven settings rows
import {
  catalogEnumChoices,
  postStateSetting,
} from '../components/shared/stateSettingRows';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';

// Side-effect: register tool card component
import '../components/tools/ToolCard';

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
  @property({ type: String }) codexSandboxMode: CodexSandboxMode =
    CODEX_SANDBOX_MODE_DEFAULT;
  @property({ type: String }) codexReasoningEffort: CodexReasoningEffort =
    CODEX_REASONING_EFFORT_DEFAULT;
  @property({ type: String }) codexApprovalPolicy: CodexApprovalPolicy =
    CODEX_APPROVAL_POLICY_DEFAULT;
  @property({ type: String }) claudeAgentModel: ClaudeAgentModel =
    CLAUDE_AGENT_DEFAULT_MODEL;
  @property({ type: String })
  claudeAgentPermissionMode: ClaudeAgentPermissionMode =
    CLAUDE_AGENT_DEFAULT_PERMISSION_MODE;
  @property({ type: String }) claudeAgentEffort: ClaudeAgentEffort =
    CLAUDE_AGENT_DEFAULT_EFFORT;

  /**
   * One catalog-backed select row: the allowed values and their labels come
   * from the `stateSettings` entry for `key`, and the change handler writes
   * that same key.
   */
  private renderSelectRow(
    label: string,
    key: WorkspaceStateKey,
    value: string,
  ): TemplateResult {
    const options = catalogEnumChoices(key);
    const onChange = (e: Event): void => {
      const selected = readSelectValue(e);
      if (selected) {
        postStateSetting(key, selected);
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

  private renderInlineSettingsFor(itemId: string): TemplateResult | null {
    let rows: ReadonlyArray<readonly [string, WorkspaceStateKey, string]>;
    if (itemId === 'codex') {
      rows = [
        [
          'Sandbox mode',
          WorkspaceStateKey.CODEX_SANDBOX_MODE,
          this.codexSandboxMode,
        ],
        [
          'Reasoning effort',
          WorkspaceStateKey.CODEX_REASONING_EFFORT,
          this.codexReasoningEffort,
        ],
        [
          'Approval policy',
          WorkspaceStateKey.CODEX_APPROVAL_POLICY,
          this.codexApprovalPolicy,
        ],
      ];
    } else if (itemId === 'claude-agent') {
      rows = [
        ['Model', WorkspaceStateKey.CLAUDE_AGENT_MODEL, this.claudeAgentModel],
        [
          'Reasoning effort',
          WorkspaceStateKey.CLAUDE_AGENT_EFFORT,
          this.claudeAgentEffort,
        ],
        [
          'Permission mode',
          WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE,
          this.claudeAgentPermissionMode,
        ],
      ];
    } else {
      return null;
    }
    return html`
      <div class="settings-section">
        ${rows.map(([label, key, value]) =>
          this.renderSelectRow(label, key, value),
        )}
      </div>
    `;
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

    const items = this.items.filter((item) => item.category === 'ai-agents');

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
