// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - formatters
import { getDateTimeFormatter } from '../formatters/timestampUtils.js';

export interface RunInfo {
  id: string;
  name?: string;
  startTime?: number | string | Date;
}

@customElement('run-selector')
export class RunSelector extends LitElement {
  @property({ type: Array }) runs: RunInfo[] = [];
  @property({ type: String }) activeRunId: string | null = null;
  @property({ type: String }) selectedRunId: string | null = null;
  @property({ type: Boolean }) visible = false;

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  private handleChange(event: Event) {
    const target = event.target as HTMLSelectElement | null;
    const value = target?.value ?? '';
    this.dispatchEvent(
      new CustomEvent('run-select', {
        detail: { runId: value || null },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private getSortedRuns() {
    const toTime = (val: RunInfo['startTime']) => {
      if (typeof val === 'number') return val;
      if (!val) return 0;
      const date = val instanceof Date ? val : new Date(val);
      const time = date.getTime();
      return Number.isNaN(time) ? 0 : time;
    };

    return [...this.runs].sort((a, b) => {
      const diff = toTime(a.startTime) - toTime(b.startTime);
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    });
  }

  private formatRunLabel(run: RunInfo) {
    const timestamp = this.formatTimestamp(run.startTime);
    return timestamp || run.name || 'Session';
  }

  private formatTimestamp(value: RunInfo['startTime']) {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return getDateTimeFormatter().format(date);
  }

  override render() {
    if (!this.visible || this.runs.length === 0) return null;
    const runs = this.getSortedRuns();
    const selected = this.selectedRunId ?? this.activeRunId ?? runs.at(-1)?.id;

    return html`
      <div class="run-selector" id="runSelectorRow">
        <span class="run-selector-title">
          <i class="codicon codicon-history"></i>
          Runs
        </span>
        <vscode-dropdown
          id="runSelector"
          .value=${selected ?? ''}
          @change=${this.handleChange}
        >
          ${repeat(
            runs,
            (run) => run.id,
            (run) => html`
              <vscode-option value=${run.id} ?selected=${run.id === selected}>
                ${this.formatRunLabel(run)}
              </vscode-option>
            `,
          )}
        </vscode-dropdown>
      </div>
    `;
  }
}
