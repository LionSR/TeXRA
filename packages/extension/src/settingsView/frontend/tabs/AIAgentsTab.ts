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
        margin-bottom: var(--wa-space-s);
      }

      .ai-agents-intro {
        margin: 0 0 var(--wa-space-s) 0;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        line-height: 1.5;
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

      .codex-inline-settings {
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        margin-bottom: var(--wa-space-2xs);
        border-radius: var(--border-radius);
        background: var(--wa-color-surface-lowered, rgba(128, 128, 128, 0.08));
      }

      .setting-row {
        display: flex;
        align-items: center;
        gap: var(--wa-space-xs);
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
      <div class="codex-inline-settings">
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
                  (item) => html`
                    <tool-card .item=${item}>
                      ${item.id === 'codex'
                        ? html`<div slot="details">
                            ${this.renderCodexInlineSettings()}
                          </div>`
                        : nothing}
                    </tool-card>
                  `,
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
