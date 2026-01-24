// Third-party imports
import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { consume } from '@lit/context';

// Local imports - progress view context
import { streamContext, type StreamContextValue } from '../../context';

/**
 * Renders follow-up input and queued items.
 */
@customElement('follow-up-section')
export class FollowUpSection extends LitElement {
  @consume({ context: streamContext, subscribe: true })
  private streamData?: StreamContextValue;

  protected createRenderRoot() {
    return this;
  }

  render() {
    const activeStream = this.streamData?.activeStream;
    if (!activeStream) {
      return html``;
    }

    const queued = this.streamData?.activeState?.queuedFollowUps ?? [];

    return html`
      <div class="panel">
        <h3>Follow-up</h3>
        <follow-up-input .streamId=${activeStream.name}></follow-up-input>
        <queued-follow-ups .messages=${queued}></queued-follow-ups>
      </div>
    `;
  }
}
