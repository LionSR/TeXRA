/**
 * ModelsTab component - API access and model settings for settings view.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';

// Local imports - settings view components (side-effect: register)
import '../components/profile/ApiAccessSection';
import '../components/profile/SignInPrompt';

@customElement('models-tab')
export class ModelsTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .models-container {
        max-width: 1000px;
        margin: 0 auto;
      }
    `,
  ];

  @property({ type: Boolean }) authenticated = false;
  @property({ type: String }) apiAccessMode: 'included' | 'personal' =
    'personal';
  @property({ attribute: false }) enabledProviders: string[] = [];
  @property({ attribute: false }) allowedModels: string[] | null = [];

  override render(): TemplateResult {
    if (!this.authenticated) {
      return html`<sign-in-prompt></sign-in-prompt>`;
    }

    return html`
      <div class="models-container">
        <api-access-section
          .mode=${this.apiAccessMode}
          .enabledProviders=${this.enabledProviders}
          .allowedModels=${this.allowedModels}
        ></api-access-section>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'models-tab': ModelsTab;
  }
}
