// Third-party imports
import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { consume } from '@lit/context';

// Local imports - progress view context
import { streamContext, type StreamContextValue } from '../../context';

/**
 * Renders tool-use content panels.
 */
@customElement('tooluse-content')
export class ToolUseContent extends LitElement {
  @consume({ context: streamContext })
  private streamData?: StreamContextValue;

  protected createRenderRoot() {
    return this;
  }

  render() {
    const state = this.streamData?.activeState;
    const runIds = Object.keys(state?.outputFilesByRun ?? {});

    return html`
      <div class="panel">
        <h3>Logs</h3>
        <log-container .logs=${state?.logs ?? []}></log-container>
      </div>
      <div class="panel">
        <h3>Task Groups</h3>
        ${state?.groups?.length
          ? state.groups.map(
              (group) => html`<task-group .group=${group}></task-group>`,
            )
          : html`<div class="empty-state">No task groups yet.</div>`}
      </div>
      <div class="panel">
        <h3>Output Files</h3>
        <run-selector
          .activeRunId=${state?.activeRunId ?? null}
          .runIds=${runIds}
        ></run-selector>
        <file-list></file-list>
      </div>
      <div class="panel">
        <h3>Todos</h3>
        <todo-list .todos=${state?.todos ?? []}></todo-list>
      </div>
      <div class="panel">
        <h3>Usage</h3>
        <usage-panel></usage-panel>
      </div>
    `;
  }
}
