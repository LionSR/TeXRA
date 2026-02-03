/**
 * AgentsTab component - remote agents for settings view.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { badgeStyles, commonViewStyles, designTokens } from '@shared/styles';

// Local imports - shared schemas
import type { RemoteAgent } from '@shared/schemas';

// Local imports - settings view components (side-effect: register)
import '../components/profile/AgentsTable';
import '../components/profile/SignInPrompt';

@customElement('agents-tab')
export class AgentsTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    ...badgeStyles,
    css`
      :host {
        display: block;
      }

      .agents-container {
        max-width: 1000px;
        margin: 0 auto;
      }

      .no-agents {
        color: var(--color-text-secondary);
        font-style: italic;
      }
    `,
  ];

  @property({ type: Boolean }) authenticated = false;
  @property({ attribute: false }) remoteAgents: RemoteAgent[] = [];

  override render(): TemplateResult {
    if (!this.authenticated) {
      return html`<sign-in-prompt></sign-in-prompt>`;
    }

    return html`
      <div class="agents-container">
        ${this.remoteAgents.length
          ? html`<agents-table .agents=${this.remoteAgents}></agents-table>`
          : html`<p class="no-agents">
              No remote agents available. Contact support@texra.ai for
              assistance.
            </p>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'agents-tab': AgentsTab;
  }
}
