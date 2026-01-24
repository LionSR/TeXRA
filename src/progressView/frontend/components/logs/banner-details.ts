// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared schemas
import type { LogMessageData } from '@shared/schemas';

/**
 * Renders a banner-style log entry.
 */
@customElement('banner-details')
export class BannerDetails extends LitElement {
  @property({ type: Object })
  log!: LogMessageData;

  protected createRenderRoot() {
    return this;
  }

  render() {
    return html`<log-line .log=${this.log}></log-line>`;
  }
}
