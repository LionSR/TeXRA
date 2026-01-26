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
import { designTokens } from '@shared/styles/litStyles';
import { codiconIconClasses } from '@shared/styles/codiconStyles';

// Local imports - shared utilities
import { CHEVRON_RIGHT_CLASS } from '@shared/utils/icons';

/** Stat item to display */
export interface ContextStatItem {
  icon: string;
  label: string;
  value: string;
}

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
    codiconIconClasses,
    css`
      :host {
        display: block;
        margin: var(--spacing-small) 0;
      }

      details {
        margin: 0;
      }

      summary {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        padding: var(--spacing-tiny) 0;
        cursor: pointer;
        list-style: none;
        user-select: none;
        opacity: var(--opacity-normal);
        color: var(--accent-color, var(--vscode-foreground));
      }

      summary:hover {
        opacity: 1;
      }

      summary::-webkit-details-marker {
        display: none;
      }

      .toggle-icon {
        opacity: var(--opacity-subtle);
        font-size: var(--font-size-sm);
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

  override render(): TemplateResult {
    if (this.items.length === 0) {
      return html`${nothing}`;
    }

    return html`
      <details style="--accent-color: ${this.config.color}">
        <summary>
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
