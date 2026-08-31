/**
 * Integrations tab for coding agents, services, reference managers, and
 * assisted inquiries. Reuses the same `tool-card` component as the Tools tab,
 * plus the Codex-specific inline settings that used to live inside ToolsTab.
 */

import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';
import {
  type ClaudeAgentEffort,
  type ClaudeAgentModel,
  type ClaudeAgentPermissionMode,
  type CodexApprovalPolicy,
  type CodexReasoningEffort,
  type CodexSandboxMode,
  type ToolDashboardItem,
  CLAUDE_AGENT_DEFAULT_EFFORT,
  CLAUDE_AGENT_DEFAULT_MODEL,
  CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
  CODEX_APPROVAL_POLICY_DEFAULT,
  CODEX_REASONING_EFFORT_DEFAULT,
  CODEX_SANDBOX_MODE_DEFAULT,
  settingsViewSettingByKey,
} from '@shared/schemas';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { renderEmptyState } from '@shared/wa/emptyState';
import { renderLoadingState } from '@shared/wa/loadingState';

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
        padding: 0;
        margin: 0 0 var(--wa-space-xs);
        font-size: var(--font-size-sm);
        list-style: none;
      }

      .ai-agents-status-stat {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
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
   * One catalog-backed select row: the allowed values, their labels, and the
   * help text all come from the `stateSettings` entry for `key`, and the
   * change handler writes that same key. Only the row label is passed in —
   * inside an integration card it reads bare ('Reasoning effort') where the
   * catalog title has to disambiguate in a flat list ('Codex reasoning
   * effort').
   */
  private renderSelectRow(
    label: string,
    key: WorkspaceStateKey,
    value: string,
  ): TemplateResult {
    const entry = settingsViewSettingByKey(key);
    if (!entry) {
      throw new Error(`No settings-view catalog row for setting "${key}"`);
    }
    const options = catalogEnumChoices(key);
    const controlId = `ai-agent-${key.replaceAll('.', '-')}`;
    const onChange = (e: Event): void => {
      const selected = readSelectValue(e);
      if (selected) {
        postStateSetting(key, selected);
      }
    };
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
      <ul class="ai-agents-status" aria-label="Integration status">
        <li class="ai-agents-status-stat ai-agents-status-available">
          ${waIcon('check')} Available: ${counts.available}
        </li>
        ${
          counts['not-found'] > 0
            ? html`
                <li class="ai-agents-status-stat ai-agents-status-missing">
                  ${waIcon('triangle-exclamation')} Need setup:
                  ${counts['not-found']}
                </li>
              `
            : nothing
        }
        ${
          pending > 0
            ? html`
                <li class="ai-agents-status-stat ai-agents-status-neutral">
                  ${waIcon('clock')} Pending: ${pending}
                </li>
              `
            : nothing
        }
      </ul>
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
