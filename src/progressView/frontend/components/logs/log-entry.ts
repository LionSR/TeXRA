// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared schemas
import { MESSAGE_TYPES, type LogMessageData } from '@shared/schemas';

/**
 * Dispatches log entries to specialized components.
 */
@customElement('log-entry')
export class LogEntry extends LitElement {
  @property({ type: Object })
  log!: LogMessageData;

  protected createRenderRoot() {
    return this;
  }

  render() {
    switch (this.log.messageType) {
      case MESSAGE_TYPES.USER_MESSAGE:
        return html`<user-message .log=${this.log}></user-message>`;
      case MESSAGE_TYPES.ERROR:
        return html`<banner-details .log=${this.log}></banner-details>`;
      case MESSAGE_TYPES.TOOL_USE:
        return html`<tool-use-entry .log=${this.log}></tool-use-entry>`;
      default:
        return html`<log-line .log=${this.log}></log-line>`;
    }
  }
}
