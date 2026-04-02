/**
 * ToolsTab component - tool dashboard showing all available tools
 * with their configuration status and installation guides.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import { codiconStyles, commonViewStyles, designTokens } from '@shared/styles';

// Local imports - shared schemas
import { createEvent } from '@shared/utils/events';
import type {
  ToolDashboardItem,
  ToolCategory,
} from '@shared/schemas/settingsViewMessages';

// Side-effect: register tool card component
import '../components/tools/ToolCard';

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
  file: { label: 'File & Shell', icon: 'codicon-files' },
  latex: { label: 'LaTeX', icon: 'codicon-file-code' },
  academic: { label: 'Academic Research', icon: 'codicon-mortar-board' },
  web: { label: 'Web', icon: 'codicon-globe' },
  computation: { label: 'Computation', icon: 'codicon-symbol-operator' },
  lean: { label: 'Lean 4', icon: 'codicon-beaker' },
  workflow: { label: 'Memory & Workflow', icon: 'codicon-type-hierarchy' },
  system: { label: 'System Dependencies', icon: 'codicon-gear' },
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
    codiconStyles,
    commonViewStyles,
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
        color: var(--vscode-foreground);
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
        stroke: var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.25));
        stroke-width: 4;
      }

      .tools-health-ring__available {
        fill: none;
        stroke: var(--vscode-testing-iconPassed, #73c991);
        stroke-width: 4;
        stroke-linecap: round;
        transition: stroke-dashoffset var(--transition-slow);
      }

      .tools-health-ring__missing {
        fill: none;
        stroke: var(--vscode-testing-iconFailed, #f48771);
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

      .tools-summary-stat .codicon {
        font-size: var(--font-size-sm);
      }

      .tools-stat-available {
        color: var(--vscode-testing-iconPassed, #73c991);
      }

      .tools-stat-missing {
        color: var(--vscode-testing-iconFailed, #f48771);
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

      .category-header .codicon {
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

      .approval-toggle-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-small) var(--spacing-medium);
        border-radius: var(--border-radius);
        background: var(--vscode-editor-background);
        margin-bottom: var(--spacing-small);
      }

      .approval-toggle-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .approval-toggle-label {
        font-size: var(--font-size);
        font-weight: var(--font-weight-medium);
      }

      .approval-toggle-description {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .approval-toggle {
        position: relative;
        display: inline-block;
        width: 36px;
        height: 20px;
        flex-shrink: 0;
      }

      .approval-toggle input {
        opacity: 0;
        width: 0;
        height: 0;
      }

      .approval-toggle-slider {
        position: absolute;
        cursor: pointer;
        inset: 0;
        background: var(--vscode-checkbox-border, #616161);
        border-radius: 10px;
        transition: background var(--transition-fast);
      }

      .approval-toggle-slider::before {
        content: '';
        position: absolute;
        height: 14px;
        width: 14px;
        left: 3px;
        bottom: 3px;
        background: var(--vscode-editor-background, #fff);
        border-radius: 50%;
        transition: transform var(--transition-fast);
      }

      .approval-toggle input:checked + .approval-toggle-slider {
        background: var(--vscode-checkbox-selectBackground, #0078d4);
      }

      .approval-toggle input:checked + .approval-toggle-slider::before {
        transform: translateX(16px);
      }
    `,
  ];

  @property({ attribute: false }) items: ToolDashboardItem[] = [];
  @property({ type: Boolean }) loaded = false;
  @property({ type: Boolean }) bashApprovalEnabled = true;
  @property({ type: Boolean }) codexApprovalEnabled = true;

  private handleRecheck(): void {
    this.dispatchEvent(createEvent('tool-recheck'));
  }

  private handleBashApprovalToggle(e: Event): void {
    const enabled = (e.target as HTMLInputElement).checked;
    this.dispatchEvent(createEvent('bash-approval-toggle', { enabled }));
  }

  private handleCodexApprovalToggle(e: Event): void {
    const enabled = (e.target as HTMLInputElement).checked;
    this.dispatchEvent(createEvent('codex-approval-toggle', { enabled }));
  }

  private renderApprovalSettings(): TemplateResult {
    return html`
      <div class="category-section">
        <div class="category-header">
          <span class="codicon codicon-shield"></span>
          Approval Settings
        </div>
        <div class="approval-toggle-row">
          <div class="approval-toggle-info">
            <span class="approval-toggle-label">Bash command approval</span>
            <span class="approval-toggle-description"
              >Require approval before executing shell commands</span
            >
          </div>
          <label class="approval-toggle">
            <input
              type="checkbox"
              .checked=${this.bashApprovalEnabled}
              @change=${this.handleBashApprovalToggle}
            />
            <span class="approval-toggle-slider"></span>
          </label>
        </div>
        <div class="approval-toggle-row">
          <div class="approval-toggle-info">
            <span class="approval-toggle-label">Codex agent approval</span>
            <span class="approval-toggle-description"
              >Require approval before launching Codex agent sessions</span
            >
          </div>
          <label class="approval-toggle">
            <input
              type="checkbox"
              .checked=${this.codexApprovalEnabled}
              @change=${this.handleCodexApprovalToggle}
            />
            <span class="approval-toggle-slider"></span>
          </label>
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
              <span class="codicon codicon-check"></span>
              ${available} available
            </span>
            ${missing > 0
              ? html`
                  <span class="tools-summary-stat tools-stat-missing">
                    <span class="codicon codicon-warning"></span>
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
          <span class="codicon ${meta.icon}"></span>
          ${meta.label}
          <span class="category-count">(${items.length})</span>
        </div>
        ${repeat(
          items,
          (item) => item.id,
          (item) => html`<tool-card .item=${item}></tool-card>`,
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
            <span class="codicon codicon-loading codicon-modifier-spin"></span>
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
              <span class="codicon codicon-refresh"></span>
              Re-check
            </button>
          </div>
        </div>

        ${this.renderApprovalSettings()}
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
