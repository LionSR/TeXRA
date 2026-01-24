// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports
import { getDateTimeFormatter } from '../formatters';

export interface RunInfo {
  id: string;
  name: string;
  startTime?: number | string;
}

@customElement('run-selector')
export class RunSelector extends LitElement {
  @property({ type: Array }) runs: RunInfo[] = [];
  @property({ type: String }) selectedRunId: string | null = null;
  @property({ type: Boolean }) visible = false;

  createRenderRoot(): HTMLElement {
    return this;
  }

  render(): TemplateResult | null {
    if (!this.visible || this.runs.length === 0) return null;

    return html`
      <div class="run-selector" id="runSelectorRow">
        <span class="run-selector-title">
          <i class="codicon codicon-history"></i>
          Run
        </span>
        <vscode-single-select id="runSelector" @change=${this.handleChange}>
          ${repeat(
            this.runs,
            (run) => run.id,
            (run) => html`
              <vscode-option
                .value=${run.id}
                ?selected=${run.id === this.selectedRunId}
              >
                ${this.formatRunLabel(run)}
              </vscode-option>
            `,
          )}
        </vscode-single-select>
      </div>
    `;
  }

  private handleChange(event: Event) {
    const target = event.target as HTMLSelectElement | null;
    const runId = target?.value ?? '';
    this.dispatchEvent(
      new CustomEvent('run-select', {
        detail: { runId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private formatRunLabel(run: RunInfo): string {
    const timestamp = this.formatTimestamp(run.startTime);
    if (timestamp) {
      return timestamp;
    }
    return run.name || 'Session';
  }

  private formatTimestamp(value?: number | string): string {
    if (!value) {
      return '';
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '';
    }

    return getDateTimeFormatter().format(date);
  }
}
