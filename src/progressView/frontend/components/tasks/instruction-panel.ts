// Third-party imports
import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { consume } from '@lit/context';

// Local imports - progress view context
import { streamContext, type StreamContextValue } from '../../context';

/**
 * Renders the latest instruction for the active stream.
 */
@customElement('instruction-panel')
export class InstructionPanel extends LitElement {
  @consume({ context: streamContext, subscribe: true })
  private streamData?: StreamContextValue;

  protected createRenderRoot() {
    return this;
  }

  render() {
    const state = this.streamData?.activeState;
    const instruction =
      state?.instruction ??
      (state?.activeRunId
        ? state.runInstructions[state.activeRunId]
        : undefined) ??
      Object.values(state?.runInstructions ?? {}).at(-1);

    if (!instruction) {
      return html``;
    }

    return html`
      <div class="panel">
        <h3>Instruction</h3>
        <div>${instruction.text}</div>
      </div>
    `;
  }
}
