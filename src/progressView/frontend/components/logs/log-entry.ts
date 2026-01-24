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
    const knownTypes = new Set<string>([
      MESSAGE_TYPES.USER_MESSAGE,
      MESSAGE_TYPES.ERROR,
      MESSAGE_TYPES.TOOL_USE,
    ]);

    if (this.log.messageType && !knownTypes.has(this.log.messageType)) {
      console.warn(`Unknown message type: ${this.log.messageType}`);
    }

    return html`<log-line .log=${this.log}></log-line>`;
  }
}
