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
import type {
  ToolDashboardItem,
  ToolCategory,
} from '@shared/schemas/settingsViewMessages';

// Local imports - tool card component (side-effect: register)
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

      .tools-container {
        max-width: 1000px;
        margin: 0 auto;
      }

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
        font-size: var(--font-size-lg, 14px);
        font-weight: 500;
        color: var(--vscode-foreground);
      }

      .tools-summary {
        display: flex;
        gap: var(--spacing-large);
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .tools-summary-stat {
        display: flex;
        align-items: center;
        gap: 4px;
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

      .tools-recheck-btn {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-small);
        padding: var(--spacing-tiny) var(--spacing-small);
        font-size: var(--font-size-xs);
        font-family: inherit;
        color: var(--color-text-secondary);
        background: none;
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--border-radius);
        cursor: pointer;
        transition:
          color 0.1s ease,
          border-color 0.1s ease;
      }

      .tools-recheck-btn:hover {
        color: var(--vscode-foreground);
        border-color: var(--vscode-focusBorder);
      }

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
        font-weight: 500;
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
    `,
  ];

  @property({ attribute: false }) items: ToolDashboardItem[] = [];
  @property({ type: Boolean }) loaded = false;

  private handleRecheck(): void {
    this.dispatchEvent(
      new CustomEvent('tool-recheck', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private groupByCategory(): Map<ToolCategory, ToolDashboardItem[]> {
    const groups = new Map<ToolCategory, ToolDashboardItem[]>();
    for (const item of this.items) {
      const existing = groups.get(item.category);
      if (existing) {
        existing.push(item);
      } else {
        groups.set(item.category, [item]);
      }
    }
    return groups;
  }

  private renderSummary(): TemplateResult | typeof nothing {
    if (this.items.length === 0) return nothing;

    const available = this.items.filter(
      (i) => i.status === 'available',
    ).length;
    const missing = this.items.filter(
      (i) => i.status === 'not-found',
    ).length;

    return html`
      <div class="tools-summary">
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
    `;
  }

  private renderCategory(
    category: ToolCategory,
    items: ToolDashboardItem[],
  ): TemplateResult {
    return html`
      <div class="category-section">
        <div class="category-header">
          <span class="codicon ${CATEGORY_META[category].icon}"></span>
          ${CATEGORY_META[category].label}
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
        <div class="tools-container">
          <div class="tools-empty">
            <span class="codicon codicon-loading codicon-modifier-spin"></span>
            Loading tool information...
          </div>
        </div>
      `;
    }

    return html`
      <div class="tools-container">
        <div class="tools-header">
          <div class="tools-title">
            <span class="codicon codicon-tools"></span>
            Tool Dashboard
          </div>
          <div class="tools-header-actions">
            ${this.renderSummary()}
            <button
              class="tools-recheck-btn"
              @click=${this.handleRecheck}
              title="Re-check tool availability"
            >
              <span class="codicon codicon-refresh"></span>
              Re-check
            </button>
          </div>
        </div>

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
