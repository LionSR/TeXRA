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

      .summary-block {
        margin-top: var(--spacing-small);
        display: block;
        width: 100%;
      }

      .summary-title {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-tiny);
        font-size: var(--font-size-sm);
        font-weight: 500;
        margin-bottom: var(--spacing-tiny);
      }

      .summary-text {
        margin: 0;
        padding: var(--spacing-small);
        white-space: pre-wrap;
        word-break: break-word;
        border: 1px solid var(--vscode-widget-border);
        border-radius: var(--radius-sm);
        background: var(--vscode-editorWidget-background);
      }
    `,
  ];

  /** Log ID for tracking */
  @property({ type: String }) logId = '';

  /** Action configuration (icon, label, color) */
  @property({ type: Object }) config: ActionConfig = {
    icon: 'codicon-history',
    label: 'Context Management',
    color: 'var(--vscode-foreground)',
  };

  /** Statistics items to display */
  @property({ type: Array }) items: ContextStatItem[] = [];

  /** Optional summary text for compaction events */
  @property({ type: String }) summary = '';

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
          ${this.summary
            ? html`
                <div class="summary-block">
                  <div class="summary-title">
                    <i class="codicon codicon-note"></i>
                    Compaction summary
                  </div>
                  <pre class="summary-text">${this.summary}</pre>
                </div>
              `
            : nothing}
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
