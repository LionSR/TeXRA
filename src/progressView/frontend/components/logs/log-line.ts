// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared schemas
import type { LogMessageData } from '@shared/schemas';

/**
 * Renders a standard log line with metadata.
 */
@customElement('log-line')
export class LogLine extends LitElement {
  @property({ type: Object })
  log!: LogMessageData;

  protected createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <div class="log-entry">
        <div class="log-entry__meta">
          ${this.log.level.toUpperCase()} •
          ${new Date(this.log.timestamp).toLocaleTimeString()}
          ${this.log.messageType ? html` • ${this.log.messageType}` : null}
        </div>
        <div>${this.log.text}</div>
      </div>
    `;
  }
}
