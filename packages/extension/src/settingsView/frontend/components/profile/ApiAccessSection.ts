/** Radio buttons to choose between included API access and personal keys. */

import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens } from '@shared/styles';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/radio/radio.js';
import '@awesome.me/webawesome/dist/components/radio-group/radio-group.js';

// Local imports - shared copy
import { PROMO_NOTICE_LONG } from '@shared/copy/promoNotice';
import { API_ACCESS_MODE_OPTIONS } from '@shared/schemas/settingsViewMessages';

// Local imports - profile view styles
import { apiAccessSectionStyles } from './ApiAccessSection.styles';

import type WaRadioGroup from '@awesome.me/webawesome/dist/components/radio-group/radio-group.js';

@customElement('api-access-section')
export class ApiAccessSection extends LitElement {
  static override styles = [designTokens, apiAccessSectionStyles];

  @property({ attribute: false }) mode: 'included' | 'personal' = 'personal';

  private handleModeChange(event: Event): void {
    const target = event.currentTarget as WaRadioGroup | null;
    const mode = target?.value === 'included' ? 'included' : 'personal';
    if (mode !== this.mode) {
      postMessage(SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE, { mode });
    }
  }

  override render(): TemplateResult {
    return html`
      <div class="api-access-section">
        <h2>Model Access</h2>
        <wa-radio-group
          class="api-access-options"
          name="apiAccessMode"
          .value=${this.mode}
          @change=${this.handleModeChange}
        >
          ${API_ACCESS_MODE_OPTIONS.map(
            (option) => html`
              <wa-radio class="api-access-option" value=${option.value}>
                <span class="option-content">
                  <span class="option-title">${option.label}</span>
                  <span class="option-description">
                    ${option.description}
                  </span>
                </span>
              </wa-radio>
            `,
          )}
        </wa-radio-group>
        ${
          this.mode === 'included'
            ? html`
                <div class="api-access-support">
                  ${waIcon('heart', { className: 'api-access-support-icon' })}
                  <span class="api-access-support-copy">
                    ${PROMO_NOTICE_LONG.supportLead}<a
                      href=${PROMO_NOTICE_LONG.supportSponsorsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      >${PROMO_NOTICE_LONG.supportSponsorsLabel}</a
                    >${PROMO_NOTICE_LONG.supportMiddle}<a
                      href=${PROMO_NOTICE_LONG.supportCoffeeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      >${PROMO_NOTICE_LONG.supportCoffeeLabel}</a
                    >${PROMO_NOTICE_LONG.supportTail}
                  </span>
                </div>
              `
            : nothing
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'api-access-section': ApiAccessSection;
  }
}
