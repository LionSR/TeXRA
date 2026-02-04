/**
 * ContextManagement component for displaying context management events.
 *
 * Displays compaction, clearing, and max_tokens reduction events
 * as collapsible details with statistics.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';
import { codiconIconClasses } from '@shared/styles/codiconStyles';

// Local imports - shared utilities
import { CHEVRON_RIGHT_CLASS } from '@shared/utils/icons';

// Local imports - local components (re-use StatItem type)
import type { StatItem } from './StatisticsPanel';

/** Re-export StatItem as ContextStatItem for backward compatibility */
export type ContextStatItem = StatItem;

/** Action configuration */
export interface ActionConfig {
  icon: string;
  label: string;
  color: string;
}

/** Extended configuration for compaction events with summary */
export interface CompactionConfig extends ActionConfig {
  summary?: string;
  compactionModel?: string;
}

@customElement('context-management')
export class ContextManagement extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    codiconIconClasses,
    css`
      :host {
        display: block;
        margin: var(--spacing-small) 0;
      }

      details {
        margin: 0;
      }

      /* Extend .details-summary from commonViewStyles with accent color */
      summary {
        color: var(--accent-color, var(--vscode-foreground));
      }

      .context-icon {
        margin-right: var(--spacing-small);
      }

      .context-title {
        font-weight: 500;
      }

      .context-content {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-large);
      }

      .stat-item {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-tiny);
        font-size: var(--font-size-sm);
      }

      .stat-item .codicon {
        opacity: 0.7;
      }

      /* Summary section for compaction events */
      .summary-section {
        margin-top: var(--spacing-small);
        border-top: 1px solid var(--vscode-panel-border);
        padding-top: var(--spacing-small);
      }

      .summary-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        font-weight: 500;
        margin-bottom: var(--spacing-tiny);
        color: var(--vscode-descriptionForeground);
        font-size: var(--font-size-sm);
      }

      .summary-content {
        background: var(--vscode-textBlockQuote-background);
        border-radius: var(--border-radius-small);
        padding: var(--spacing-small);
        font-size: var(--font-size-sm);
        white-space: pre-wrap;
        font-family: var(--vscode-editor-font-family);
        max-height: 200px;
        overflow-y: auto;
      }

      .summary-content.collapsed {
        max-height: 4em;
        overflow: hidden;
      }

      .summary-toggle {
        background: none;
        border: none;
        color: var(--vscode-textLink-foreground);
        cursor: pointer;
        padding: var(--spacing-tiny);
        font-size: var(--font-size-sm);
      }

      .summary-toggle:hover {
        text-decoration: underline;
      }
    `,
  ];

  /** Log ID for tracking */
  @property({ type: String }) logId = '';

  /** Action configuration (icon, label, color, optional summary) */
  @property({ type: Object }) config: CompactionConfig = {
    icon: 'codicon-history',
    label: 'Context Management',
    color: 'var(--vscode-foreground)',
  };

  /** Statistics items to display */
  @property({ type: Array }) items: ContextStatItem[] = [];

  /** Whether the summary is expanded */
  @property({ type: Boolean }) summaryExpanded = false;

  private toggleSummary(): void {
    this.summaryExpanded = !this.summaryExpanded;
  }

  private renderSummarySection(): TemplateResult | typeof nothing {
    if (!this.config.summary) {
      return nothing;
    }

    const modelInfo = this.config.compactionModel
      ? ` (via ${this.config.compactionModel})`
      : '';

    return html`
      <div class="summary-section">
        <div class="summary-header">
          <i class="codicon codicon-note"></i>
          <span>Compaction Summary${modelInfo}</span>
          <button
            class="summary-toggle"
            aria-expanded="${this.summaryExpanded}"
            @click=${this.toggleSummary}
          >
            ${this.summaryExpanded ? 'Collapse' : 'Expand'}
          </button>
        </div>
        <div class="summary-content ${this.summaryExpanded ? '' : 'collapsed'}">
          ${this.config.summary}
        </div>
      </div>
    `;
  }

  override render(): TemplateResult {
    if (this.items.length === 0) {
      return html`${nothing}`;
    }

    return html`
      <details style="--accent-color: ${this.config.color}">
        <summary class="details-summary">
          <i class="${CHEVRON_RIGHT_CLASS} toggle-icon"></i>
          <i
            class="codicon ${this.config.icon} context-icon"
            style="color: ${this.config.color}"
          ></i>
          <span class="context-title" style="color: ${this.config.color}"
            >${this.config.label}</span
          >
        </summary>
        <div class="context-content" data-log-id=${this.logId}>
          ${repeat(
            this.items,
            (item) => item.label,
            (item) => html`
              <span class="stat-item" title=${item.label}>
                <i class="codicon ${item.icon}"></i>
                ${item.value}
              </span>
            `,
          )}
          ${this.renderSummarySection()}
        </div>
      </details>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'context-management': ContextManagement;
  }
}
