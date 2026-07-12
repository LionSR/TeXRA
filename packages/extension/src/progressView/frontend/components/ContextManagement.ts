/** Displays compaction / clearing / max_tokens reduction events as collapsible details. */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';
import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';

// Local imports - progress view helpers
import { buildDetailsSummary } from '../formatters/htmlBuilders';

// Local imports - local components (re-use StatItem type)
import type { StatItem } from './StatisticsPanel';

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
    css`
      :host {
        display: block;
        margin: var(--wa-space-2xs) 0;
      }

      wa-details {
        margin: 0;
      }

      /* Extend .details-summary from commonViewStyles with accent color */
      .details-summary,
      .details-summary .icon,
      .context-title {
        color: var(--accent-color, var(--wa-color-text-normal));
      }

      .context-title {
        font-weight: var(--font-weight-medium);
      }

      .context-content {
        display: flex;
        flex-wrap: wrap;
        gap: var(--wa-space-s);
      }

      .stat-item {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        font-size: var(--font-size-sm);
      }

      .stat-item wa-icon {
        opacity: var(--opacity-subtle);
      }

      .summary-block {
        margin-top: var(--wa-space-2xs);
        display: block;
        width: 100%;
      }

      .summary-title {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        margin-bottom: var(--wa-space-3xs);
      }

      .summary-text {
        margin: 0;
        padding: var(--wa-space-2xs);
        white-space: pre-wrap;
        word-break: break-word;
        border: var(--border-thin) solid var(--wa-color-surface-border);
        border-radius: var(--border-radius-small);
        background: var(--wa-color-surface-raised);
      }
    `,
  ];

  /** Log ID for tracking */
  @property({ attribute: false }) logId = '';

  /** Action configuration (icon, label, color) */
  @property({ attribute: false }) config: ActionConfig = {
    icon: 'history',
    label: 'Context Management',
    color: 'var(--wa-color-text-normal)',
  };

  /** Statistics items to display */
  @property({ attribute: false }) items: StatItem[] = [];

  /** Optional summary text for compaction events */
  @property({ attribute: false }) summary = '';

  override render(): TemplateResult | typeof nothing {
    if (this.items.length === 0) {
      return nothing;
    }

    return html`
      <wa-details
        class="banner-details"
        appearance="plain"
        style="--accent-color: ${this.config.color}"
      >
        ${buildDetailsSummary({
          iconName: this.config.icon,
          label: this.config.label,
          labelClass: 'context-title',
        })}
        <div class="context-content" data-log-id=${this.logId}>
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
          ${
            this.summary
              ? html`
                  <div class="summary-block">
                    <div class="summary-title">
                      <wa-icon
                        library=${TEXRA_ICON_LIBRARY}
                        name="note"
                        aria-hidden="true"
                      ></wa-icon>
                      Compaction summary
                    </div>
                    <pre class="summary-text">${this.summary}</pre>
                  </div>
                `
              : nothing
          }
        </div>
      </wa-details>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'context-management': ContextManagement;
  }
}
