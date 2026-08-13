/** Displays compaction / clearing / max_tokens reduction events as collapsible details. */

// Third-party imports
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Local imports - progress view helpers
import { buildDetailsSummary } from '../formatters/htmlBuilders';

// Local imports - styles
import { bannerDetailsWaDetailsStyles } from '../styles/logEntryStyles';
import { contextManagementStyles } from './ContextManagement.styles';

/** Stat item to display */
export interface StatItem {
  icon: TeXRAIconName;
  label: string;
  value: string;
}

/** Action configuration */
export interface ActionConfig {
  icon: TeXRAIconName;
  label: string;
  color: string;
}

@customElement('context-management')
export class ContextManagement extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    bannerDetailsWaDetailsStyles,
    contextManagementStyles,
  ];

  /** Log ID for tracking */
  @property({ attribute: false }) logId = '';

  /** Action configuration (icon, label, color) — every call site supplies one. */
  @property({ attribute: false }) config!: ActionConfig;

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
            (item, index) => html`
              <span id="context-stat-${index}" class="stat-item">
                ${waIcon(item.icon)} ${item.value}
              </span>
              <wa-tooltip for="context-stat-${index}">${item.label}</wa-tooltip>
            `,
          )}
          ${
            this.summary
              ? html`
                  <div class="summary-block">
                    <div class="summary-title">
                      ${waIcon('note-sticky')} Compaction summary
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
