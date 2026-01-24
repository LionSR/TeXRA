// Third-party imports
import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { consume } from '@lit/context';

// Local imports - progress view context
import { streamContext, type StreamContextValue } from '../../context';

/**
 * Renders workflow content panels.
 */
@customElement('workflow-content')
export class WorkflowContent extends LitElement {
  @consume({ context: streamContext, subscribe: true })
  private streamData?: StreamContextValue;

  protected createRenderRoot() {
    return this;
  }

  render() {
    const state = this.streamData?.activeState;
    const runIds = Object.keys(state?.outputFilesByRun ?? {});

    return html`<task-panels .state=${state} .runIds=${runIds}></task-panels>`;
  }
}
