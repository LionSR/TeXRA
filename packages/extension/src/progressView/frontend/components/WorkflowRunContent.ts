/**
 * A workflow run's conversation: the header, its pending approvals, the
 * inquiries it is waiting on, then the run board for a workflow-script run
 * or the transcript log for any other, and the files and usage it closes
 * with. Reads the view and the surface; every send is a child's event.
 */

// Third-party imports
import { html, LitElement, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared contracts
import type { AgentCategory } from '@shared/schemas';
import type { SessionView, RunView } from '@shared/session/sessionView';
import type { Surface } from '@shared/session/surface';

// Local imports - progress view
import { conversationContentStyles } from './ConversationContent.styles';

// Side-effect imports - register the elements rendered below
import './BackgroundTasksPanel';
import './FileList';
import './LogList';
import './RequestPanels';
import './RunHeader';
import './UsagePanel';
import './WorkflowRunBoard';

type WorkflowRunView = Extract<
  RunView,
  { readonly category: typeof AgentCategory.Workflow }
>;

@customElement('workflow-run-content')
export class WorkflowRunContent extends LitElement {
  static override styles = conversationContentStyles;

  @property({ attribute: false }) run!: WorkflowRunView;
  @property({ attribute: false }) view!: SessionView;
  @property({ attribute: false }) surface!: Surface;
  /** The host's clock, for the run board's elapsed times. */
  @property({ type: Number }) nowMs: number | null = null;

  override render(): TemplateResult {
    const { run, view, surface } = this;
    const approvals = view.approvals
      .filter((entry) => entry.runId === run.id)
      .map((entry) => entry.payload);
    const { transcript } = run;
    return html`
      <run-header .run=${run} .view=${view} .surface=${surface}></run-header>

      <div class="conversation-content">
        ${
          approvals.length > 0
            ? html`<div class="conversation-column conversation-approval-dock">
                <request-panels
                  .permissions=${approvals}
                  .view=${view}
                  .readOnly=${run.readOnly === true}
                ></request-panels>
              </div>`
            : nothing
        }

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
            : html`<div class="conversation-log">
                <log-list .run=${run} .surface=${surface}></log-list>
              </div>`
        }

        <div class="conversation-column conversation-epilogue">
          <file-list
            .runId=${run.id}
            .surface=${surface}
            .filesByRound=${run.files}
            .failuresByRound=${run.compileFailures}
          ></file-list>

          <usage-panel
            .usage=${run.usage}
            .contextState=${run.context}
          ></usage-panel>
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
