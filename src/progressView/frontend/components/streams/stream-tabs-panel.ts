// Third-party imports
import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { consume } from '@lit/context';

// Local imports - progress view context
import { streamContext, type StreamContextValue } from '../../context';

/**
 * Renders the list of stream tabs.
 */
@customElement('stream-tabs-panel')
export class StreamTabsPanel extends LitElement {
  @consume({ context: streamContext, subscribe: true })
  private streamData?: StreamContextValue;

  protected createRenderRoot() {
    return this;
  }

  render() {
    const streams = this.streamData?.streams ?? [];
    if (!streams.length) {
      return html`<div class="empty-state">No active streams yet.</div>`;
    }

    return html`
      <div class="stream-tabs">
        ${streams.map(
          (stream) => html`
            <stream-tab
              .stream=${stream}
              .active=${stream.name === this.streamData?.activeStreamId}
            ></stream-tab>
          `,
        )}
      </div>
    `;
  }
}
