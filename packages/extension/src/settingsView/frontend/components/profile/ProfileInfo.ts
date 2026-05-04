/**
 * ProfileInfo component - displays user email, ID, tier, and sign out button.
 */

// Third-party imports
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { badgeStyles, designTokens } from '@shared/styles';

// Local imports - shared copy
import { PROMO_NOTICE_LONG } from '@shared/copy/promoNotice';

// Local imports - profile view styles
import { profileViewStyles } from './styles';

// Local imports - profile view events
import { ProfileViewEvents } from './events';

@customElement('profile-info')
export class ProfileInfo extends LitElement {
  static override styles = [designTokens, ...badgeStyles, profileViewStyles];

  @property({ attribute: false }) email = '';
  @property({ attribute: false }) userId = '';
  @property({ attribute: false }) tier = 'free';
  @property({ attribute: false }) accessExpiresAt: string | null = null;
  @property({ attribute: false }) showSignOut = false;

  private handleSignOut(): void {
    this.dispatchEvent(ProfileViewEvents.signOut());
  }

  private formatExpiration(): string | null {
    if (!this.accessExpiresAt) return null;
    const date = new Date(this.accessExpiresAt);
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  override render(): TemplateResult {
    const expiration = this.formatExpiration();
    return html`
      <div class="profile-info">
        <div class="info-row">
          <span class="label">Email:</span>
          <span class="value">${this.email || 'N/A'}</span>
        </div>
        <div class="info-row">
          <span class="label">User ID:</span>
          <span class="value">${this.userId}</span>
        </div>
        <div class="info-row">
          <span class="label">Tier:</span>
          <span class="badge tier-badge ${this.tier.toLowerCase()}">
            ${this.tier}
          </span>
        </div>
        <div class="profile-notice">
          ${PROMO_NOTICE_LONG.promoLead}<code>${PROMO_NOTICE_LONG.promoCode}</code>${PROMO_NOTICE_LONG.promoTail}
          ${PROMO_NOTICE_LONG.privacyLead}<strong>${PROMO_NOTICE_LONG.privacyNot}</strong>${PROMO_NOTICE_LONG.privacyMiddle}<strong>${PROMO_NOTICE_LONG.privacyNever}</strong>${PROMO_NOTICE_LONG.privacyTrailing}
        </div>
        <div class="profile-notice">
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
        </div>
        ${expiration
          ? html`
              <div class="info-row">
                <span class="label">Access Expires:</span>
                <span class="value">${expiration}</span>
              </div>
            `
          : nothing}
        ${this.showSignOut
          ? html`
              <div class="profile-actions">
                <vscode-toolbar-button
                  icon="sign-out"
                  label="Sign Out"
                  title="Sign out"
                  @click=${this.handleSignOut}
                ></vscode-toolbar-button>
              </div>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'profile-info': ProfileInfo;
  }
}
