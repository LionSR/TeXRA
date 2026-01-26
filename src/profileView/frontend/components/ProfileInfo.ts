// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens } from '@shared/styles';

// Local imports - profile view styles
import { profileViewStyles } from '../styles';

// Local imports - profile view events
import { ProfileViewEvents } from '../events';

@customElement('profile-info')
export class ProfileInfo extends LitElement {
  static styles = [designTokens, profileViewStyles];

  @property({ type: String }) email = '';
  @property({ type: String }) userId = '';
  @property({ type: String }) tier = 'free';
  @property({ type: String }) accessExpiresAt: string | null = null;
  @property({ type: Boolean }) showSignOut = false;

  private handleSignOut = (): void => {
    this.dispatchEvent(ProfileViewEvents.signOut());
  };

  private formatExpiration(): string | null {
    if (!this.accessExpiresAt) return null;
    const date = new Date(this.accessExpiresAt);
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  render(): TemplateResult {
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
        ${expiration
          ? html`
              <div class="info-row">
                <span class="label">Access Expires:</span>
                <span class="value">${expiration}</span>
              </div>
            `
          : ''}
        ${this.showSignOut
          ? html`
              <div class="profile-actions">
                <vscode-button @click=${this.handleSignOut}>
                  Sign out
                </vscode-button>
              </div>
            `
          : ''}
      </div>
    `;
  }
}
