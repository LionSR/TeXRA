/**
 * ToolsTab component - tool dashboard showing all available tools
 * with their configuration status and installation guides.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import {
  commonViewStyles,
  designTokens,
  tintedBadgeStyles,
} from '@shared/styles';

// Side-effect imports - register WA icon and spinner components
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';

// Local imports - shared schemas
import { createEvent } from '@shared/utils/events';
import type {
  ToolDashboardItem,
  ToolCategory,
  CodexSandboxMode,
  CodexReasoningEffort,
  CodexApprovalPolicy,
} from '@shared/schemas/settingsViewMessages';

// Side-effect: register tool card component
import '../components/tools/ToolCard';

/** Sandbox mode display labels — single source of truth for the UI. */
const SANDBOX_MODE_OPTIONS: readonly {
  value: CodexSandboxMode;
  label: string;
}[] = [
  { value: 'read-only', label: 'Read-only' },
  { value: 'workspace-write', label: 'Workspace write' },
  { value: 'danger-full-access', label: 'Full access' },
] as const;

/** Reasoning effort display labels — single source of truth for the UI. */
const REASONING_EFFORT_OPTIONS: readonly {
  value: CodexReasoningEffort;
  label: string;
}[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
] as const;

/** Codex approval policy display labels — single source of truth for the UI. */
const APPROVAL_POLICY_OPTIONS: readonly {
  value: CodexApprovalPolicy;
  label: string;
}[] = [
  { value: 'never', label: 'Auto approve' },
  { value: 'on-request', label: 'Ask when requested' },
  { value: 'untrusted', label: 'Ask for untrusted' },
  { value: 'on-failure', label: 'Ask on failure' },
] as const;

/** Per-category display metadata. */
interface CategoryMeta {
  readonly label: string;
  readonly icon: string;
}

/**
 * Single definition for category display metadata.
 * Record<ToolCategory, ...> ensures every category has an entry —
 * adding a new variant to ToolCategorySchema without an entry here
 * is a compile error.
 */
const CATEGORY_META: Record<ToolCategory, CategoryMeta> = {
  file: { label: 'File & Shell', icon: 'files' },
  latex: { label: 'LaTeX', icon: 'file-code' },
  academic: { label: 'Academic Research', icon: 'mortar-board' },
  web: { label: 'Web', icon: 'globe' },
  computation: { label: 'Computation', icon: 'symbol-operator' },
  lean: { label: 'Lean 4', icon: 'beaker' },
  workflow: { label: 'Memory & Workflow', icon: 'type-hierarchy' },
  system: { label: 'System Dependencies', icon: 'gear' },
};

/** Canonical category display order. */
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

@customElement('tools-tab')
export class ToolsTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    tintedBadgeStyles,
    css`
      :host {
        display: block;
      }

      /* max-width and centering provided by .tab-content-container */

      .tools-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--spacing-large);
      }

      .tools-title {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-medium);
        color: var(--texra-foreground);
      }

      .tools-summary {
        display: flex;
        align-items: center;
        gap: var(--spacing-large);
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .tools-health-ring {
        display: flex;
        align-items: center;
        gap: var(--spacing-medium);
      }

      .tools-health-ring svg {
        width: 36px;
        height: 36px;
        transform: rotate(-90deg);
      }

      .tools-health-ring__track {
        fill: none;
        stroke: var(--texra-editorWidget-border, rgba(128, 128, 128, 0.25));
        stroke-width: 4;
      }

      .tools-health-ring__available {
        fill: none;
        stroke: var(--texra-testing-iconPassed, #73c991);
        stroke-width: 4;
        stroke-linecap: round;
        transition: stroke-dashoffset var(--transition-slow);
      }

      .tools-health-ring__missing {
        fill: none;
        stroke: var(--texra-testing-iconFailed, #f48771);
        stroke-width: 4;
        stroke-linecap: round;
        transition: stroke-dashoffset var(--transition-slow);
      }

      .tools-health-labels {
        display: flex;
        flex-direction: column;
        gap: 1px;
      }

      .tools-summary-stat {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
      }

      .tools-summary-stat wa-icon {
        font-size: var(--font-size-sm);
      }

      .tools-stat-available {
        color: var(--texra-testing-iconPassed, #73c991);
      }

      .tools-stat-missing {
        color: var(--texra-testing-iconFailed, #f48771);
      }

      /* Base recheck-btn styles provided by .tab-action-btn in commonViewStyles */

      .category-section {
        margin-bottom: var(--spacing-large);
      }

      .category-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        padding-bottom: var(--spacing-small);
        margin-bottom: var(--spacing-medium);
        border-bottom: var(--border-thin) solid var(--color-border);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .category-header wa-icon {
        font-size: var(--font-size);
      }

      .category-count {
        font-weight: normal;
        opacity: var(--opacity-normal);
      }

      .tools-empty {
        text-align: center;
        padding: var(--spacing-large);
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
      }

      .tools-header-actions {
        display: flex;
        align-items: center;
        gap: var(--spacing-medium);
      }

      .setting-block {
        margin-bottom: var(--spacing-small);
      }

      .desktop-settings {
        padding: var(--spacing-medium);
        margin-bottom: var(--spacing-medium);
        background-color: var(--texra-editor-inactiveSelectionBackground);
        border-radius: var(--border-radius);
      }

      .desktop-settings-title {
        font-weight: 600;
        margin: 0;
      }

      .desktop-settings-description {
        margin: var(--spacing-small) 0 0 0;
        font-size: var(--font-size-sm);
        color: var(--texra-descriptionForeground);
      }

      .desktop-settings-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        margin-top: var(--spacing-small);
        flex-wrap: wrap;
      }

      .codex-inline-settings {
        padding: var(--spacing-small) var(--spacing-medium);
        margin-bottom: var(--spacing-small);
        border-radius: var(--border-radius);
        background: var(
          --texra-textCodeBlock-background,
          rgba(128, 128, 128, 0.08)
        );
      }

      .setting-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-medium);
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
  @property({ type: Boolean }) bashApprovalEnabled = true;
  @property({ type: String }) codexSandboxMode = 'workspace-write';
  @property({ type: String }) codexReasoningEffort = 'high';
  @property({ type: String }) codexApprovalPolicy = 'never';
  @property({ attribute: false }) showDesktopCrashReporting = false;
  @property({ attribute: false }) desktopCrashReportingEnabled = false;
  @property({ attribute: false }) desktopCrashReportingConfigured = false;

  private handleRecheck(): void {
    this.dispatchEvent(createEvent('tool-recheck'));
  }

  private emitToggle(eventName: string, e: Event): void {
    const target = e.target as HTMLInputElement | null;
    this.dispatchEvent(
      createEvent(eventName, { enabled: Boolean(target?.checked) }),
    );
  }

  private handleBashApprovalToggle = (e: Event): void => {
    this.emitToggle('bash-approval-toggle', e);
  };

  private emitSelect(eventName: string, key: string, e: Event): void {
    const value = (e.target as HTMLSelectElement | null)?.value;
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

  private handleDesktopCrashReportingToggle = (e: Event): void => {
    this.emitToggle('desktop-crash-reporting-toggle', e);
  };

  private handleSetDesktopCrashReportingDsn = (): void => {
    this.dispatchEvent(createEvent('desktop-crash-reporting-dsn-set', {}));
  };

  private renderApprovalSettings(): TemplateResult {
    return html`
      <div class="category-section">
        <div class="category-header">
          <wa-icon library="texra" name="shield"></wa-icon>
          Approval &amp; Safety
        </div>

        <div class="setting-block">
          <vscode-checkbox
            ?checked=${this.bashApprovalEnabled}
            @change=${this.handleBashApprovalToggle}
          >
            Require approval for shell commands &amp; Codex sessions
          </vscode-checkbox>
        </div>
      </div>
    `;
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
        <vscode-single-select
          class="setting-select"
          .value=${value}
          @change=${onChange}
        >
          ${options.map(
            (opt) => html`
              <vscode-option
                value=${opt.value}
                ?selected=${value === opt.value}
              >
                ${opt.label}
              </vscode-option>
            `,
          )}
        </vscode-single-select>
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

  private renderDesktopCrashReporting(): TemplateResult | typeof nothing {
    if (!this.showDesktopCrashReporting) return nothing;
    return html`
      <div class="category-section">
        <div class="category-header">
          <wa-icon library="texra" name="desktop-download"></wa-icon>
          Desktop Diagnostics
        </div>
        <div class="desktop-settings">
          <p class="desktop-settings-title">Native crash reporting</p>
          <p class="desktop-settings-description">
            Opt-in native crash capture for the standalone Electron app. Reports
            are scrubbed before upload and performance tracing stays disabled.
          </p>
          <div class="desktop-settings-row">
            <vscode-checkbox
              ?checked=${this.desktopCrashReportingEnabled}
              @change=${this.handleDesktopCrashReportingToggle}
            >
              Enable native crash reporting
            </vscode-checkbox>
            <span
              class=${this.desktopCrashReportingConfigured
                ? 'tinted-badge tinted-badge--ok'
                : 'tinted-badge tinted-badge--warn'}
            >
              ${this.desktopCrashReportingConfigured
                ? 'DSN set'
                : 'DSN missing'}
            </span>
            <button
              class="tab-action-btn"
              @click=${this.handleSetDesktopCrashReportingDsn}
            >
              <wa-icon library="texra" name="key"></wa-icon>
              ${this.desktopCrashReportingConfigured
                ? 'Replace DSN'
                : 'Set DSN'}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private groupByCategory(): Map<ToolCategory, ToolDashboardItem[]> {
    const groups = new Map<ToolCategory, ToolDashboardItem[]>();
    for (const item of this.items) {
      const list = groups.get(item.category) ?? [];
      list.push(item);
      groups.set(item.category, list);
    }
    return groups;
  }

  private renderSummary(): TemplateResult | typeof nothing {
    if (this.items.length === 0) return nothing;

    let available = 0;
    let missing = 0;
    for (const item of this.items) {
      if (item.status === 'available') available++;
      else if (item.status === 'not-found') missing++;
    }

    const total = this.items.length;
    const r = 14; // radius
    const circ = 2 * Math.PI * r;
    const availPct = total > 0 ? available / total : 0;
    const missPct = total > 0 ? missing / total : 0;
    const availLen = circ * availPct;
    const missLen = circ * missPct;
    const availOffset = circ - availLen;
    // Missing arc starts after the available arc
    const missOffset = circ - missLen;
    const missRotation = availPct * 360;

    return html`
      <div class="tools-summary">
        <div class="tools-health-ring">
          <svg viewBox="0 0 36 36">
            <circle class="tools-health-ring__track" cx="18" cy="18" r="${r}" />
            <circle
              class="tools-health-ring__available"
              cx="18"
              cy="18"
              r="${r}"
              stroke-dasharray="${circ}"
              stroke-dashoffset="${availOffset}"
            />
            ${missing > 0
              ? html`<circle
                  class="tools-health-ring__missing"
                  cx="18"
                  cy="18"
                  r="${r}"
                  stroke-dasharray="${circ}"
                  stroke-dashoffset="${missOffset}"
                  style="transform: rotate(${missRotation}deg); transform-origin: 50% 50%"
                />`
              : nothing}
          </svg>
          <div class="tools-health-labels">
            <span class="tools-summary-stat tools-stat-available">
              <wa-icon library="texra" name="check"></wa-icon>
              ${available} available
            </span>
            ${missing > 0
              ? html`
                  <span class="tools-summary-stat tools-stat-missing">
                    <wa-icon library="texra" name="warning"></wa-icon>
                    ${missing} need setup
                  </span>
                `
              : nothing}
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
        <div class="category-header">
          <wa-icon library="texra" name=${meta.icon}></wa-icon>
          ${meta.label}
          <span class="category-count">(${items.length})</span>
        </div>
        ${repeat(
          items,
          (item) => item.id,
          (item) => html`
            <tool-card .item=${item}>
              ${category === 'computation' && item.id === 'codex'
                ? html`<div slot="details">
                    ${this.renderCodexInlineSettings()}
                  </div>`
                : nothing}
            </tool-card>
          `,
        )}
      </div>
    `;
  }

  override render(): TemplateResult {
    const groups = this.groupByCategory();

    if (!this.loaded) {
      return html`
        <div class="tools-container tab-content-container">
          <div class="tools-empty">
            <wa-spinner></wa-spinner>
            Loading tool information...
          </div>
        </div>
      `;
    }

    return html`
      <div class="tools-container tab-content-container">
        <div class="tools-header">
          <div class="tools-header-actions">
            ${this.renderSummary()}
            <button
              class="tab-action-btn"
              @click=${this.handleRecheck}
              title="Re-check tool availability"
            >
              <wa-icon library="texra" name="refresh"></wa-icon>
              Re-check
            </button>
          </div>
        </div>

        ${this.renderApprovalSettings()} ${this.renderDesktopCrashReporting()}
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
