/**
 * AI Agents tab — shows third-party agent integrations (Codex, Claude Code,
 * external chat handoffs) grouped on their own panel. Reuses the same
 * `tool-card` component as the Tools tab, plus the Codex-specific inline
 * settings that used to live inside ToolsTab.
 */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';

// Local imports - shared schemas
import { createEvent } from '@shared/utils/events';
import type {
  ToolDashboardItem,
  CodexSandboxMode,
  CodexReasoningEffort,
  CodexApprovalPolicy,
  ClaudeAgentEffort,
  ClaudeAgentModel,
  ClaudeAgentPermissionMode,
} from '@shared/schemas/settingsViewMessages';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import type WaSelect from '@awesome.me/webawesome/dist/components/select/select.js';

// Side-effect: register tool card component
import '../components/tools/ToolCard';

const SANDBOX_MODE_OPTIONS: readonly {
  value: CodexSandboxMode;
  label: string;
}[] = [
  { value: 'read-only', label: 'Read-only' },
  { value: 'workspace-write', label: 'Workspace write' },
  { value: 'danger-full-access', label: 'Full access' },
] as const;

const REASONING_EFFORT_OPTIONS: readonly {
  value: CodexReasoningEffort;
  label: string;
}[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
] as const;

const APPROVAL_POLICY_OPTIONS: readonly {
  value: CodexApprovalPolicy;
  label: string;
}[] = [
  { value: 'never', label: 'Auto approve' },
  { value: 'on-request', label: 'Ask when requested' },
  { value: 'untrusted', label: 'Ask for untrusted' },
  { value: 'on-failure', label: 'Ask on failure' },
] as const;

const CLAUDE_MODEL_OPTIONS: readonly {
  value: ClaudeAgentModel;
  label: string;
}[] = [
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
] as const;

const CLAUDE_PERMISSION_MODE_OPTIONS: readonly {
  value: ClaudeAgentPermissionMode;
  label: string;
}[] = [
  { value: 'default', label: 'Prompt for risky actions' },
  { value: 'acceptEdits', label: 'Auto-accept edits' },
  { value: 'bypassPermissions', label: 'Bypass all (dangerous)' },
  { value: 'plan', label: 'Plan only (read-only)' },
] as const;

const CLAUDE_EFFORT_OPTIONS: readonly {
  value: ClaudeAgentEffort;
  label: string;
}[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Maximum' },
] as const;

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

      .category-section {
        margin-bottom: var(--wa-space-m);
      }

      .agent-inline-settings {
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        margin-bottom: var(--wa-space-2xs);
        border-radius: var(--border-radius);
        background: var(--wa-color-surface-lowered, rgba(128, 128, 128, 0.08));
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
    'claude-sonnet-4-6';
  @property({ type: String })
  claudeAgentPermissionMode: ClaudeAgentPermissionMode = 'acceptEdits';
  @property({ type: String }) claudeAgentEffort: ClaudeAgentEffort = 'high';

  private handleRecheck(): void {
    this.dispatchEvent(createEvent('tool-recheck'));
  }

  private emitSelect(eventName: string, key: string, e: Event): void {
    const select = e.currentTarget as WaSelect | null;
    const value = typeof select?.value === 'string' ? select.value : '';
    if (value) {
      this.dispatchEvent(createEvent(eventName, { [key]: value }));
    }
  }

  private handleCodexSandboxModeChange = (e: Event): void => {
    this.emitSelect('codex-sandbox-mode-change', 'mode', e);
  };

  private handleCodexReasoningEffortChange = (e: Event): void => {
    this.emitSelect('codex-reasoning-effort-change', 'effort', e);
  };

  private handleCodexApprovalPolicyChange = (e: Event): void => {
    this.emitSelect('codex-approval-policy-change', 'policy', e);
  };

  private handleClaudeAgentModelChange = (e: Event): void => {
    this.emitSelect('claude-agent-model-change', 'model', e);
  };

  private handleClaudeAgentPermissionModeChange = (e: Event): void => {
    this.emitSelect('claude-agent-permission-mode-change', 'mode', e);
  };

  private handleClaudeAgentEffortChange = (e: Event): void => {
    this.emitSelect('claude-agent-effort-change', 'effort', e);
  };

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
          this.handleCodexSandboxModeChange,
        )}
        ${this.renderSelectRow(
          'Reasoning effort',
          this.codexReasoningEffort,
          REASONING_EFFORT_OPTIONS,
          this.handleCodexReasoningEffortChange,
        )}
        ${this.renderSelectRow(
          'Approval policy',
          this.codexApprovalPolicy,
          APPROVAL_POLICY_OPTIONS,
          this.handleCodexApprovalPolicyChange,
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
          this.handleClaudeAgentModelChange,
        )}
        ${this.renderSelectRow(
          'Reasoning effort',
          this.claudeAgentEffort,
          CLAUDE_EFFORT_OPTIONS,
          this.handleClaudeAgentEffortChange,
        )}
        ${this.renderSelectRow(
          'Permission mode',
          this.claudeAgentPermissionMode,
          CLAUDE_PERMISSION_MODE_OPTIONS,
          this.handleClaudeAgentPermissionModeChange,
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

  override render(): TemplateResult {
    if (!this.loaded) {
      return html`
        <div class="tab-content-container">
          <div class="ai-agents-empty">
            <wa-spinner></wa-spinner>
            Loading integrations…
          </div>
        </div>
      `;
    }

    const items = this.aiAgentItems();

    return html`
      <div class="tab-content-container">
        <div class="ai-agents-header">
          <p class="ai-agents-intro">
            Delegate work to third-party AI coding agents. Each integration uses
            its own authentication (OAuth login, OAuth token, or API key) and
            runs locally on your machine.
          </p>
          <button
            class="tab-action-btn"
            @click=${this.handleRecheck}
            title="Re-check integration availability"
          >
            <wa-icon library="texra" name="refresh"></wa-icon>
            Re-check
          </button>
        </div>

        ${items.length === 0
          ? html`<div class="ai-agents-empty">
              No AI agent integrations registered.
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
                        ${inlineSettings
                          ? html`<div slot="details">${inlineSettings}</div>`
                          : nothing}
                      </tool-card>
                    `;
                  },
                )}
              </div>
            `}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ai-agents-tab': AIAgentsTab;
  }
}
