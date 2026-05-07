/**
 * ApiAccessSection component - radio buttons to choose between included API access or personal keys.
 */

// Third-party imports
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { codiconStyles, designTokens } from '@shared/styles';

// Local imports - shared copy
import { PROMO_NOTICE_LONG } from '@shared/copy/promoNotice';

// Local imports - profile view styles
import { profileViewStyles } from './styles';

// Local imports - profile view events
import { ProfileViewEvents } from './events';

@customElement('api-access-section')
export class ApiAccessSection extends LitElement {
  static override styles = [designTokens, codiconStyles, profileViewStyles];

  @property({ attribute: false }) mode: 'included' | 'personal' = 'personal';

  private handleModeChange(event: Event): void {
    const target = event.currentTarget as HTMLInputElement | null;
    const mode = target?.value === 'included' ? 'included' : 'personal';
    if (mode !== this.mode) {
      this.dispatchEvent(ProfileViewEvents.setApiAccessMode({ mode }));
    }
  }

  override render(): TemplateResult {
    return html`
      <div class="api-access-section">
        <h2>Model Access</h2>
        <div class="api-access-options">
          <label class="api-access-option">
            <input
              type="radio"
              name="apiAccessMode"
              value="included"
              .checked=${this.mode === 'included'}
              @change=${this.handleModeChange}
            />
            <span class="option-content">
              <span class="option-title">Use Included Access</span>
              <span class="option-description"
                >Works automatically. No setup needed. Does not apply to
                OpenRouter — those models always use your OpenRouter key. Bring
                your own provider API keys to use more of your own quota and
                avoid relay caps.</span
              >
            </span>
          </label>
          <label class="api-access-option">
            <input
              type="radio"
              name="apiAccessMode"
              value="personal"
              .checked=${this.mode === 'personal'}
              @change=${this.handleModeChange}
            />
            <span class="option-content">
              <span class="option-title">Use My Own Keys</span>
              <span class="option-description"
                >Provide your own API keys from OpenAI, Anthropic, etc. This
                uses your provider account directly for higher limits and models
                outside Included Access.</span
              >
            </span>
          </label>
        </div>
        ${this.mode === 'included'
          ? html`
              <div class="api-access-support">
                <span
                  class="codicon codicon-heart api-access-support-icon"
                  aria-hidden="true"
                ></span>
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
