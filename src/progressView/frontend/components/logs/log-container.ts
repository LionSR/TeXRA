// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared schemas
import type { LogMessageData } from '@shared/schemas';

/**
 * Renders a list of log entries.
 */
@customElement('log-container')
export class LogContainer extends LitElement {
  @property({ type: Array })
  logs: LogMessageData[] = [];

  protected createRenderRoot() {
    return this;
  }

  render() {
    if (!this.logs.length) {
      return html`<div class="empty-state">No logs yet.</div>`;
    }

    return html`${this.logs.map(
      (log) => html`<log-entry .log=${log}></log-entry>`,
    )}`;
  }
}
