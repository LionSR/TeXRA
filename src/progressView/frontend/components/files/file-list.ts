// Third-party imports
import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { consume } from '@lit/context';

// Local imports - progress view context
import { streamContext, type StreamContextValue } from '../../context';

/**
 * Renders output files grouped by round.
 */
@customElement('file-list')
export class FileList extends LitElement {
  @consume({ context: streamContext, subscribe: true })
  private streamData?: StreamContextValue;

  protected createRenderRoot() {
    return this;
  }

  render() {
    const state = this.streamData?.activeState;
    if (!state) {
      return html`<div class="empty-state">No files yet.</div>`;
    }

    const runId =
      state.activeRunId ?? Object.keys(state.outputFilesByRun).at(-1) ?? null;
    if (!runId) {
      return html`<div class="empty-state">No files yet.</div>`;
    }

    const rounds = state.outputFilesByRun[runId] ?? {};
    const roundEntries = Object.entries(rounds).sort(
      ([a], [b]) => Number(a) - Number(b),
    );
    const missingRounds = state.missingOutputsByRun[runId] ?? {};
    const missingEntries = Object.entries(missingRounds).sort(
      ([a], [b]) => Number(a) - Number(b),
    );

    if (!roundEntries.length) {
      return html`<div class="empty-state">No files yet.</div>`;
    }

    return html`
      ${roundEntries.map(
        ([round, files]) => html`
          <round-collapsible
            .round=${round}
            .files=${files}
          ></round-collapsible>
        `,
      )}
      ${missingEntries.length
        ? html`
            <div>
              <div class="log-entry__meta">Missing outputs</div>
              ${missingEntries.map(
                ([round, files]) => html`
                  <div class="file-entry">
                    <div>Round ${round}</div>
                    <div>${files.join(', ')}</div>
                  </div>
                `,
              )}
            </div>
          `
        : null}
    `;
  }
}
