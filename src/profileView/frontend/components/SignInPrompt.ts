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
  static styles = [
    designTokens,
    codiconStyles,
    profileViewStyles,
    css`
      :host {
        display: block;
      }

      .not-authenticated {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-medium);
        align-items: flex-start;
      }
    `,
  ];

  private handleSignIn = (): void => {
    this.dispatchEvent(ProfileViewEvents.signIn());
  };

  render(): TemplateResult {
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
