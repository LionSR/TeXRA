/**
 * StatisticsPanel component for displaying token usage statistics.
 *
 * Renders a collapsible details section with usage metrics.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';

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
    css`
      :host {
        display: block;
        margin: var(--wa-space-2xs) 0;
      }

      details {
        margin: 0;
      }

      .statistics-content {
        display: flex;
        flex-wrap: wrap;
        gap: var(--wa-space-s);
      }

      .stat-item {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
      }
    `,
  ];

  /** Log ID for tracking */
  @property({ attribute: false }) logId = '';

  /** Statistics items to display */
  @property({ attribute: false }) items: StatItem[] = [];

  override render(): TemplateResult | typeof nothing {
    if (this.items.length === 0) {
      return nothing;
    }

    return html`
      <details>
        <summary class="details-summary">
          <wa-icon
            library="texra"
            name="chevron-right"
            class="toggle-icon"
            aria-hidden="true"
          ></wa-icon>
          <wa-icon
            library="texra"
            name="graph"
            class="icon"
            aria-hidden="true"
          ></wa-icon>
          <span>Statistics</span>
        </summary>
        <div class="statistics-content" data-log-id=${this.logId}>
          ${repeat(
            this.items,
            (item) => item.label,
            (item) => html`
              <span class="stat-item" title=${item.label}>
                <wa-icon
                  library="texra"
                  name=${item.icon}
                  aria-hidden="true"
                ></wa-icon>
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
