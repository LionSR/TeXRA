// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared schemas
import type { LogMessageData } from '@shared/schemas';

/**
 * Renders a tool use log entry.
 */
@customElement('tool-use-entry')
export class ToolUseEntry extends LitElement {
  @property({ type: Object })
  log!: LogMessageData;

  protected createRenderRoot() {
    return this;
  }

  render() {
    return html`<log-line .log=${this.log}></log-line>`;
  }
}
