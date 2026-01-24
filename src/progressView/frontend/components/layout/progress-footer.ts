// Third-party imports
import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';

/**
 * Renders the ProgressView footer area.
 */
@customElement('progress-footer')
export class ProgressFooter extends LitElement {
  protected createRenderRoot() {
    return this;
  }

  render() {
    return html`<follow-up-section></follow-up-section>`;
  }
}
