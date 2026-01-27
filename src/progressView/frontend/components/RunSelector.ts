// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - progress view
// Note: Design tokens from tokens.css are inherited into Shadow DOM via :root
import { getDateTimeFormatter } from '../formatters/timestampUtils';
import { ProgressEvents } from '../events';

@customElement('run-selector')
export class RunSelector extends LitElement {
  static override styles = css`
    :host {
      display: block;
      min-width: 180px;
      max-width: 260px;
      flex-shrink: 0;
    }

    :host([hidden]) {
      display: none;
    }

    /* Constrain dropdown listbox height to prevent viewport overflow */
    vscode-single-select::part(listbox) {
      max-height: var(--height-large);
    }
  `;

  @property({ type: Array }) runs: Array<{
    id: string;
    name?: string;
    startTime?: number | string | Date;
  }> = [];
  @property({ type: String }) activeRunId: string | null = null;

  override render(): TemplateResult {
    const sortedRuns = [...this.runs].sort((a, b) => {
      const aTime = this.toTime(a.startTime);
      const bTime = this.toTime(b.startTime);
      return aTime !== bTime ? aTime - bTime : a.id.localeCompare(b.id);
    });

    return html`
      <vscode-single-select
        id="runSelector"
        aria-label="Select session"
        .value=${this.activeRunId ?? ''}
        @change=${this.handleChange}
      >
        <span slot="placeholder">No sessions</span>
        ${repeat(
          sortedRuns,
          (run) => run.id,
          (run) => html`
            <vscode-option value=${run.id}>
              ${this.formatRunLabel(run)}
            </vscode-option>
          `,
        )}
      </vscode-single-select>
    `;
  }

  /** Handle select change from the run selector. */
  private handleChange(event: Event): void {
    const target = event.target as HTMLSelectElement | null;
    const runId = target?.value ?? '';
    this.dispatchEvent(ProgressEvents.runSelected({ runId: runId || null }));
  }

  private formatRunLabel(run: {
    id: string;
    name?: string;
    startTime?: number | string | Date;
  }): string {
    const timestamp = this.formatTimestamp(run.startTime);
    if (timestamp) return timestamp;
    return run.name ?? 'Session';
  }

  private formatTimestamp(value?: number | string | Date): string {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return getDateTimeFormatter().format(date);
  }

  private toTime(value?: number | string | Date): number {
    if (typeof value === 'number') return value;
    if (value instanceof Date) {
      const time = value.getTime();
      return Number.isNaN(time) ? 0 : time;
    }
    if (!value) return 0;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
}
