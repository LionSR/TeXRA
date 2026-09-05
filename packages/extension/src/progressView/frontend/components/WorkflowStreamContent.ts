/**
 * A workflow stream's conversation: the header, its pending approvals, the
 * inquiries it is waiting on, then the run board for a workflow-script run
 * or the transcript log for any other, and the files and usage it closes
 * with. Reads the view and the surface; every send is a child's event.
 */

// Third-party imports
import { html, LitElement, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared contracts
import type { AgentCategory } from '@shared/schemas';
import type { SessionView, StreamView } from '@shared/session/sessionView';
import type { Surface } from '@shared/session/surface';

// Local imports - progress view
import { totalRunUsage } from '../usageTotals';
import { conversationContentStyles } from './ConversationContent.styles';

// Side-effect imports - register the elements rendered below
import './BackgroundTasksPanel';
import './FileList';
import './LogList';
import './RequestPanels';
import './StreamHeader';
import './UsagePanel';
import './WorkflowRunBoard';

type WorkflowStreamView = Extract<
  StreamView,
  { readonly category: typeof AgentCategory.Workflow }
>;

@customElement('workflow-stream-content')
export class WorkflowStreamContent extends LitElement {
  static override styles = conversationContentStyles;

  @property({ attribute: false }) stream!: WorkflowStreamView;
  @property({ attribute: false }) view!: SessionView;
  @property({ attribute: false }) surface!: Surface;
  /** The host's clock, for the run board's elapsed times. */
  @property({ type: Number }) nowMs: number | null = null;

  override render(): TemplateResult {
    const { stream, view, surface } = this;
    const approvals = view.approvals
      .filter((entry) => entry.streamId === stream.id)
      .map((entry) => entry.payload);
    const { transcript } = stream;
    return html`
      <stream-header
        .stream=${stream}
        .view=${view}
        .surface=${surface}
      ></stream-header>

      <div class="conversation-content">
        ${
          approvals.length > 0
            ? html`<div class="conversation-column conversation-approval-dock">
                <request-panels
                  .permissions=${approvals}
                  .view=${view}
                  .readOnly=${stream.readOnly === true}
                ></request-panels>
              </div>`
            : nothing
        }

        <div class="conversation-column conversation-prelude">
          <background-tasks-panel
            scope="inquiries"
            .stream=${stream}
            .view=${view}
          ></background-tasks-panel>
        </div>

        ${
          transcript.run
            ? html`<workflow-run-board
                .stream=${stream}
                .view=${view}
                .surface=${surface}
                .nowMs=${this.nowMs}
              ></workflow-run-board>`
            : html`<div class="conversation-log">
                <log-list .stream=${stream} .surface=${surface}></log-list>
              </div>`
        }

        <div class="conversation-column conversation-epilogue">
          <file-list
            .streamId=${stream.id}
            .filesByRound=${stream.files}
            .failuresByRound=${stream.compileFailures}
          ></file-list>

          <usage-panel
            .usage=${totalRunUsage(stream.usage)}
            .contextState=${stream.context}
          ></usage-panel>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'workflow-stream-content': WorkflowStreamContent;
  }
}
