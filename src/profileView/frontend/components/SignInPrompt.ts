/**
 * SignInPrompt component - displays sign in button when user is not authenticated.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens, codiconStyles } from '@shared/styles';
import { profileViewStyles } from '../styles';

// Local imports - profile view events
import { ProfileViewEvents } from '../events';

@customElement('sign-in-prompt')
export class SignInPrompt extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    profileViewStyles,
    css`
      :host {
        display: block;
      }
    `,
  ];

  private handleSignIn(): void {
    this.dispatchEvent(ProfileViewEvents.signIn());
  }

  override render(): TemplateResult {
    return html`
      <div class="not-authenticated">
        <p>You are not signed in to TeXRA.</p>
        <vscode-button @click=${this.handleSignIn}>
          <span slot="start" class="codicon codicon-sign-in"></span>
          Sign In
        </vscode-button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sign-in-prompt': SignInPrompt;
  }
}
