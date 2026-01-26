/**
 * LogPlaceholder component for displaying placeholder content in log views.
 *
 * Uses Shadow DOM for style encapsulation.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

// Local imports - shared styles
import { designTokens } from '@shared/styles/litStyles';

@customElement('log-placeholder')
export class LogPlaceholder extends LitElement {
  static override styles = [
    designTokens,
    css`
      :host {
        display: block;
        text-align: center;
        color: var(--color-text-secondary);
        padding: var(--spacing-large) var(--spacing-medium);
      }

      a {
        color: var(--color-text-link);
        text-decoration: underline;
      }

      a:hover {
        text-decoration: none;
      }
    `,
  ];

  /** HTML content to display (supports links) */
  @property({ type: String }) content = '';

  override render(): TemplateResult {
    return html`${unsafeHTML(this.content)}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'log-placeholder': LogPlaceholder;
  }
}
