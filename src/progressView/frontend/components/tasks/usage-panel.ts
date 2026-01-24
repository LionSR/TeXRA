// Third-party imports
import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { consume } from '@lit/context';

// Local imports - progress view context
import { streamContext, type StreamContextValue } from '../../context';

/**
 * Renders token usage metrics for the active stream.
 */
@customElement('usage-panel')
export class UsagePanel extends LitElement {
  @consume({ context: streamContext, subscribe: true })
  private streamData?: StreamContextValue;

  protected createRenderRoot() {
    return this;
  }

  render() {
    const usageByRun = this.streamData?.activeState?.usageByRun ?? {};
    const entries = Object.entries(usageByRun);

    const context = this.streamData?.activeState?.contextState ?? null;

    return html`
      ${entries.length
        ? entries.map(
            ([runId, usage]) => html`
              <div class="log-entry">
                <div class="log-entry__meta">Run ${runId}</div>
                <div>
                  Input: ${usage.inputTokens} • Output: ${usage.outputTokens} •
                  Cost: $${usage.cost.toFixed(4)}
                </div>
              </div>
            `,
          )
        : html`<div class="empty-state">No usage yet.</div>`}
      ${context
        ? html`
            <div class="log-entry">
              <div class="log-entry__meta">Context</div>
              <div>
                ${context.utilizationPercent.toFixed(1)}% used •
                ${context.inputTokens} / ${context.contextWindow} tokens
              </div>
            </div>
          `
        : null}
    `;
  }
}
