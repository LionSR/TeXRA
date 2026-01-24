// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/**
 * Renders queued follow-up messages.
 */
@customElement('queued-follow-ups')
export class QueuedFollowUps extends LitElement {
  @property({ type: Array })
  messages: string[] = [];

  protected createRenderRoot() {
    return this;
  }

  render() {
    if (!this.messages.length) {
      return html``;
    }

    return html`
      <div>
        <div class="log-entry__meta">Queued follow-ups</div>
        <ul>
          ${this.messages.map((item) => html`<li>${item}</li>`)}
        </ul>
      </div>
    `;
  }
}
