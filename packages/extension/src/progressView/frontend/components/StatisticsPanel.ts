/**
 * StatisticsPanel component for displaying token usage statistics.
 *
 * Renders a collapsible details section with usage metrics.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/details/details.js';

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

      wa-details {
        margin: 0;
      }

      .statistics-content {
        display: flex;
        flex-wrap: wrap;
        gap: var(--wa-space-2xs) var(--wa-space-s);
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        margin-top: var(--wa-space-2xs);
        background: color-mix(
          in srgb,
          var(--wa-color-neutral-fill-quiet) 50%,
          transparent
        );
        border-radius: var(--border-radius-small);
        border: var(--border-thin) solid
          color-mix(in srgb, var(--color-border) 70%, transparent);
      }

      .stat-item {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        font-variant-numeric: tabular-nums;
        color: var(--wa-color-text-normal);
      }

      .stat-item wa-icon {
        color: var(--wa-color-text-quiet);
        font-size: var(--font-size-sm);
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
      <wa-details>
        <span slot="summary" class="details-summary">
          <wa-icon
            library="texra"
            name="graph"
            class="icon"
            aria-hidden="true"
          ></wa-icon>
          <span>Statistics</span>
        </span>
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
      </wa-details>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'statistics-panel': StatisticsPanel;
  }
}
