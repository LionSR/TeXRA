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

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';

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
    css`
      :host {
        display: block;
        margin: var(--spacing-small) 0;
      }

      details {
        margin: 0;
      }

      /* Extend .details-summary from commonViewStyles with accent color */
      summary,
      .context-icon,
      .context-title {
        color: var(--accent-color, var(--texra-foreground));
      }

      .context-icon {
        margin-right: var(--spacing-small);
      }

      .context-title {
        font-weight: var(--font-weight-medium);
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

      .stat-item wa-icon {
        opacity: var(--opacity-subtle);
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
        font-weight: var(--font-weight-medium);
        margin-bottom: var(--spacing-tiny);
      }

      .summary-text {
        margin: 0;
        padding: var(--spacing-small);
        white-space: pre-wrap;
        word-break: break-word;
        border: var(--border-thin) solid var(--texra-widget-border);
        border-radius: var(--border-radius-small);
        background: var(--texra-editorWidget-background);
      }
    `,
  ];

  /** Log ID for tracking */
  @property({ attribute: false }) logId = '';

  /** Action configuration (icon, label, color) */
  @property({ attribute: false }) config: ActionConfig = {
    icon: 'history',
    label: 'Context Management',
    color: 'var(--texra-foreground)',
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
      <details style="--accent-color: ${this.config.color}">
        <summary class="details-summary">
          <wa-icon
            library="texra"
            name="chevron-right"
            class="toggle-icon"
            aria-hidden="true"
          ></wa-icon>
          <wa-icon
            library="texra"
            name=${this.config.icon}
            class="context-icon"
            aria-hidden="true"
          ></wa-icon>
          <span class="context-title">${this.config.label}</span>
        </summary>
        <div class="context-content" data-log-id=${this.logId}>
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
          ${this.summary
            ? html`
                <div class="summary-block">
                  <div class="summary-title">
                    <wa-icon
                      library="texra"
                      name="note"
                      aria-hidden="true"
                    ></wa-icon>
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
