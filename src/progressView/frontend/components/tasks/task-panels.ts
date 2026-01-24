// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - progress view state
import type { StreamState } from '../../state/streamState';

/**
 * Renders the shared task panels layout.
 */
@customElement('task-panels')
export class TaskPanels extends LitElement {
  @property({ type: Object })
  state?: StreamState;

  @property({ type: Array })
  runIds: string[] = [];

  protected createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <div class="panel">
        <h3>Logs</h3>
        <log-container .logs=${this.state?.logs ?? []}></log-container>
      </div>
      <div class="panel">
        <h3>Task Groups</h3>
        ${this.state?.groups?.length
          ? this.state.groups.map(
              (group) => html`<task-group .group=${group}></task-group>`,
            )
          : html`<div class="empty-state">No task groups yet.</div>`}
      </div>
      <div class="panel">
        <h3>Output Files</h3>
        <run-selector
          .activeRunId=${this.state?.activeRunId ?? null}
          .runIds=${this.runIds}
        ></run-selector>
        <file-list></file-list>
      </div>
      <div class="panel">
        <h3>Todos</h3>
        <todo-list .todos=${this.state?.todos ?? []}></todo-list>
      </div>
      <div class="panel">
        <h3>Usage</h3>
        <usage-panel></usage-panel>
      </div>
    `;
  }
}
