/** Collapsible token-usage stats panel. */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { ifDefined } from 'lit/directives/if-defined.js';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';
import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';

// Local imports - progress view helpers
import { buildDetailsSummary } from '../formatters/htmlBuilders';

// Local imports - local components (StatItem's home is ContextManagement)
import type { StatItem } from './ContextManagement';

@customElement('statistics-panel')
export class StatisticsPanel extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      wa-details {
        margin: var(--wa-space-2xs) 0;
        content-visibility: auto;
        contain-intrinsic-size: auto 40px;
      }

      .statistics-content {
        display: flex;
        flex-wrap: wrap;
        gap: var(--wa-space-2xs) var(--wa-space-s);
        padding: var(--wa-space-3xs) 0 var(--wa-space-2xs) var(--wa-space-s);
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
      <wa-details
        class="banner-details"
        appearance="plain"
        data-log-id=${ifDefined(this.logId || undefined)}
      >
        ${buildDetailsSummary({
          iconName: 'graph',
          label: 'Statistics',
        })}
        <div class="statistics-content">
          ${repeat(
            this.items,
            (item) => item.label,
            (item) => html`
              <span class="stat-item" title=${item.label}>
                <wa-icon
                  library=${TEXRA_ICON_LIBRARY}
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
