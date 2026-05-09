/** Displays compaction / clearing / max_tokens reduction events as collapsible details. */

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

      details {
        margin: 0;
      }

      /* Extend .details-summary from commonViewStyles with accent color */
      summary,
      .context-icon,
      .context-title {
        color: var(--accent-color, var(--wa-color-text-normal));
      }

      .context-icon {
        margin-right: var(--wa-space-2xs);
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
      <details
        class="banner-details"
        style="--accent-color: ${this.config.color}"
      >
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
