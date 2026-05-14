/** Tool dashboard showing tool status and installation guides. */

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
  ToolCategory,
} from '@shared/schemas/settingsViewMessages';

// Side-effect imports - register WA icon and spinner components
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';
import type WaCheckbox from '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';

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
  file: { label: 'File & Shell', icon: 'files' },
  latex: { label: 'LaTeX', icon: 'file-code' },
  academic: { label: 'Academic Research', icon: 'mortar-board' },
  web: { label: 'Web', icon: 'globe' },
  computation: { label: 'Computation', icon: 'symbol-operator' },
  lean: { label: 'Lean 4', icon: 'beaker' },
  workflow: { label: 'Memory & Workflow', icon: 'type-hierarchy' },
  system: { label: 'System Dependencies', icon: 'gear' },
  // ai-agents lives on its own tab (AIAgentsTab); keep the meta entry so the
  // Record stays exhaustive and the type checker enforces it.
  'ai-agents': { label: 'AI Agents', icon: 'robot' },
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

      /* max-width and centering provided by .tab-content-container */

      .tools-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--wa-space-s);
      }

      .tools-title {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-medium);
        color: var(--wa-color-text-normal);
      }

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

      .tools-health-ring svg {
        width: 36px;
        height: 36px;
        transform: rotate(-90deg);
      }

      .tools-health-ring__track {
        fill: none;
        stroke: var(--wa-color-surface-border, rgba(128, 128, 128, 0.25));
        stroke-width: 4;
      }

      .tools-health-ring__available {
        fill: none;
        stroke: var(--wa-color-testing-passed, #73c991);
        stroke-width: 4;
        stroke-linecap: round;
      }

      .tools-health-ring__missing {
        fill: none;
        stroke: var(--wa-color-testing-failed, #f48771);
        stroke-width: 4;
        stroke-linecap: round;
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
        color: var(--wa-color-testing-passed, #73c991);
      }

      .tools-stat-missing {
        color: var(--wa-color-testing-failed, #f48771);
      }

      /* Base recheck-btn styles provided by .tab-action-btn in commonViewStyles */

      .category-section {
        margin-bottom: var(--wa-space-s);
      }

      /* .category-header chrome lives in commonViewStyles. */
      .category-header wa-icon {
        font-size: var(--font-size);
      }

      .category-count {
        font-weight: normal;
        opacity: var(--opacity-normal);
      }

      .tools-empty {
        text-align: center;
        padding: var(--wa-space-s);
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
      }

      .tools-header-actions {
        display: flex;
        align-items: center;
        gap: var(--wa-space-xs);
      }

      .setting-block {
        margin-bottom: var(--wa-space-2xs);
      }

      .desktop-settings {
        padding: var(--wa-space-xs);
        margin-bottom: var(--wa-space-xs);
        background-color: var(--wa-color-neutral-fill-quiet);
        border-radius: var(--border-radius);
      }

      .desktop-settings-title {
        font-weight: var(--font-weight-semibold);
        margin: 0;
      }

      .desktop-settings-description {
        margin: var(--wa-space-2xs) 0 0 0;
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-quiet);
      }

      .desktop-settings-row {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        margin-top: var(--wa-space-2xs);
        flex-wrap: wrap;
      }
    `,
  ];

  @property({ attribute: false }) items: ToolDashboardItem[] = [];
  @property({ type: Boolean }) loaded = false;
  @property({ type: Boolean }) bashApprovalEnabled = true;
  @property({ attribute: false }) showDesktopCrashReporting = false;
  @property({ attribute: false }) desktopCrashReportingEnabled = false;
  @property({ attribute: false }) desktopCrashReportingConfigured = false;

  private handleRecheck(): void {
    this.dispatchEvent(createEvent('tool-recheck'));
  }

  private emitToggle(eventName: string, e: Event): void {
    const target = e.target as WaCheckbox | null;
    this.dispatchEvent(
      createEvent(eventName, { enabled: Boolean(target?.checked) }),
    );
  }

  private handleBashApprovalToggle = (e: Event): void => {
    this.emitToggle('bash-approval-toggle', e);
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
          <wa-checkbox
            ?checked=${this.bashApprovalEnabled}
            @change=${this.handleBashApprovalToggle}
          >
            Require approval for shell commands &amp; agent sessions
          </wa-checkbox>
        </div>
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
            <wa-checkbox
              ?checked=${this.desktopCrashReportingEnabled}
              @change=${this.handleDesktopCrashReportingToggle}
            >
              Enable native crash reporting
            </wa-checkbox>
            <wa-tag
              variant=${this.desktopCrashReportingConfigured
                ? 'success'
                : 'warning'}
              size="small"
            >
              ${this.desktopCrashReportingConfigured
                ? 'DSN set'
                : 'DSN missing'}
            </wa-tag>
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

  private visibleItems(): ToolDashboardItem[] {
    return this.items.filter((item) => TOOLS_TAB_CATEGORIES.has(item.category));
  }

  private groupByCategory(): Map<ToolCategory, ToolDashboardItem[]> {
    const groups = new Map<ToolCategory, ToolDashboardItem[]>();
    for (const item of this.visibleItems()) {
      const list = groups.get(item.category) ?? [];
      list.push(item);
      groups.set(item.category, list);
    }
    return groups;
  }

  private renderSummary(): TemplateResult | typeof nothing {
    const items = this.visibleItems();
    if (items.length === 0) return nothing;

    let available = 0;
    let missing = 0;
    for (const item of items) {
      if (item.status === 'available') available++;
      else if (item.status === 'not-found') missing++;
    }

    // Early return above guarantees items.length > 0.
    const total = items.length;
    const r = 14;
    const circ = 2 * Math.PI * r;
    const availPct = available / total;
    const missPct = missing / total;
    const availOffset = circ - circ * availPct;
    // Missing arc starts after the available arc.
    const missOffset = circ - circ * missPct;
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
