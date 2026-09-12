/**
 * A workflow run's conversation: the header, its pending approvals, the
 * inquiries it is waiting on, then the run board for a workflow-script run
 * or the transcript log for any other, and the files and usage it closes
 * with. Reads the view and the surface; every send is a child's event.
 */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Local imports - progress view
import { BaseRunContent } from './BaseRunContent';
import { conversationContentStyles } from './ConversationContent.styles';

// Side-effect imports - register the elements rendered below
import './BackgroundTasksPanel';
import './FileList';
import './RunHeader';
import './WorkflowRunBoard';

@customElement('workflow-run-content')
export class WorkflowRunContent extends BaseRunContent {
  static override styles = conversationContentStyles;

  override render(): TemplateResult | typeof nothing {
    const { run, view, surface } = this;
    if (!run || !view || !surface || run.category !== 'workflow') {
      return nothing;
    }
    const { transcript } = run;
    return html`
      <run-header .run=${run} .view=${view}></run-header>

      <div class="conversation-content">
        ${this.renderApprovalDock()}

        <div class="conversation-column conversation-prelude">
          <background-tasks-panel
            scope="inquiries"
            .run=${run}
            .view=${view}
            .surface=${surface}
          ></background-tasks-panel>
        </div>

        ${
          transcript.run
            ? html`<workflow-run-board
                .run=${run}
                .view=${view}
                .surface=${surface}
                .nowMs=${this.nowMs}
              ></workflow-run-board>`
            : this.renderLog()
        }

        <div class="conversation-column conversation-epilogue">
          <file-list
            .runId=${run.id}
            .surface=${surface}
            .filesByRound=${run.files}
            .failuresByRound=${run.compileFailures}
          ></file-list>

          ${this.renderUsagePanel(run)}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'workflow-run-content': WorkflowRunContent;
  }
}
