/**
 * StatisticsPanel component for displaying token usage statistics.
 *
 * Renders a collapsible details section with usage metrics.
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

/** Stat item to display */
export interface StatItem {
  icon: string;
  label: string;
  value: string;
}

@customElement('statistics-panel')
export class StatisticsPanel extends LitElement {
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

      .statistics-content {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-large);
      }

      .stat-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
      }
    `,
  ];

  /** Log ID for tracking */
  @property({ type: String }) logId = '';

  /** Statistics items to display */
  @property({ type: Array }) items: StatItem[] = [];

  override render(): TemplateResult {
    if (this.items.length === 0) {
      return html`${nothing}`;
    }

    return html`
      <details>
        <summary class="details-summary">
          <i class="${CHEVRON_RIGHT_CLASS} toggle-icon"></i>
          <i class="codicon codicon-graph"></i>
          <span>Statistics</span>
        </summary>
        <div class="statistics-content" data-log-id=${this.logId}>
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
        </div>
      </details>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'statistics-panel': StatisticsPanel;
  }
}
