// Third-party imports
import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { consume } from '@lit/context';

// Local imports - shared schemas
import { AgentCategory } from '@shared/schemas';

// Local imports - progress view context
import { streamContext, type StreamContextValue } from '../../context';

/**
 * Renders the main content area for logs and artifacts.
 */
@customElement('content-area')
export class ContentArea extends LitElement {
  @consume({ context: streamContext })
  private streamData?: StreamContextValue;

  protected createRenderRoot() {
    return this;
  }

  render() {
    const activeStream = this.streamData?.activeStream;
    if (!activeStream) {
      return html`<div class="content"></div>`;
    }

    const isWorkflow = activeStream.agentCategory === AgentCategory.Workflow;

    return html`
      <div class="content">
        ${isWorkflow
          ? html`<workflow-content></workflow-content>`
          : html`<tooluse-content></tooluse-content>`}
      </div>
    `;
  }
}
