/** Radio buttons to choose between included API access and personal keys. */

import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens } from '@shared/styles';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/radio/radio.js';
import '@awesome.me/webawesome/dist/components/radio-group/radio-group.js';

// Local imports - shared copy
import { PROMO_NOTICE_LONG } from '@shared/copy/promoNotice';

// Local imports - profile view styles
import { profileViewStyles } from './styles';

// Local imports - profile view events
import { ProfileViewEvents } from './events';
import type WaRadioGroup from '@awesome.me/webawesome/dist/components/radio-group/radio-group.js';

@customElement('api-access-section')
export class ApiAccessSection extends LitElement {
  static override styles = [designTokens, profileViewStyles];

  @property({ attribute: false }) mode: 'included' | 'personal' = 'personal';

  private handleModeChange(event: Event): void {
    const target = event.currentTarget as WaRadioGroup | null;
    const mode = target?.value === 'included' ? 'included' : 'personal';
    if (mode !== this.mode) {
      this.dispatchEvent(ProfileViewEvents.setApiAccessMode({ mode }));
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
          <wa-radio class="api-access-option" value="included">
            <span class="option-content">
              <span class="option-title">Use Included Access</span>
              <span class="option-description"
                >Works automatically. No setup needed. Does not apply to
                OpenRouter — those models always use your OpenRouter key. Bring
                your own provider API keys to use more of your own quota and
                avoid relay caps.</span
              >
            </span>
          </wa-radio>
          <wa-radio class="api-access-option" value="personal">
            <span class="option-content">
              <span class="option-title">Use My Own Keys</span>
              <span class="option-description"
                >Provide your own API keys from OpenAI, Anthropic, etc. This
                uses your provider account directly for higher limits and models
                outside Included Access.</span
              >
            </span>
          </wa-radio>
        </wa-radio-group>
        ${this.mode === 'included'
          ? html`
              <div class="api-access-support">
                <wa-icon
                  library="texra"
                  name="heart"
                  class="api-access-support-icon"
                  aria-hidden="true"
                ></wa-icon>
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
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'api-access-section': ApiAccessSection;
  }
}
