/** Displays compaction / clearing / max_tokens reduction events as collapsible details. */

// Third-party imports
import {
  LitElement,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - shared styles
import type { IconName } from '@ui/wa/iconNames';
import { designTokens, commonViewStyles } from '@ui/styles';
import { waIcon } from '@ui/wa/webAwesomeIcons';

// Local imports - progress view helpers
import { buildDetailsCard } from '../formatters/htmlBuilders';

// Local imports - styles
import { bannerDetailsWaDetailsStyles } from '../styles/logEntryStyles';
import { contextManagementStyles } from './ContextManagement.styles';

/** Stat item to display. Local to this renderer (icon-resolved); the
 *  transcript's own `StatItem` is the key-based row shape it derives from. */
interface StatItem {
  icon: IconName;
  label: string;
  value: string;
}

/** Action configuration */
export interface ActionConfig {
  icon: IconName;
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

  /** Action configuration (icon, label, color) — every call site supplies one. */
  @property({ attribute: false }) config!: ActionConfig;

  /** Statistics items to display */
  @property({ attribute: false }) items: StatItem[] = [];

  // The event colour tints the summary icon (`--accent-color` in the
  // component's styles), set on the host so the card's markup is the shared
  // shell's.
  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('config')) {
      this.style.setProperty('--accent-color', this.config.color);
    }
  }

  override render(): TemplateResult | typeof nothing {
    if (this.items.length === 0) {
      return nothing;
    }

    return html`
      ${buildDetailsCard({
        summary: {
          iconName: this.config.icon,
          label: this.config.label,
          labelClass: 'context-title',
        },
        body: html`<div class="context-content">
          ${repeat(
            this.items,
            (item) => item.label,
            (item, index) => html`
              <span id="context-stat-${index}" class="stat-item">
                ${waIcon(item.icon)}
                <span class="visually-hidden">${item.label}: </span>
                <bdi class="stat-value">${item.value}</bdi>
              </span>
              <wa-tooltip for="context-stat-${index}">${item.label}</wa-tooltip>
            `,
          )}
        </div>`,
      })}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'context-management': ContextManagement;
  }
}
