/**
 * A document task's conversation: the header, its pending requests, the
 * inquiries it is waiting on, then the transcript log, the files and usage
 * it closes with, and once it has ended, what the user can do next. Reads the view
 * and the surface; every send is a child's event.
 */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

import { documentsOf } from '@shared/plugins/documents';
import { isLiveRun } from '@shared/session/sessionView';

// Local imports - progress view
import { BaseRunContent } from './BaseRunContent';
import { conversationContentStyles } from './ConversationContent.styles';

// Side-effect imports - register the elements rendered below
import './BackgroundTasksPanel';
import './FileList';

@customElement('workflow-run-content')
export class WorkflowRunContent extends BaseRunContent {
  static override styles = conversationContentStyles;

  override render(): TemplateResult | typeof nothing {
    const { run, view, surface } = this;
    if (!run || !view || !surface || !run.documentTask) return nothing;
    const documents = documentsOf(run);
    return html`
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

        ${this.renderLog()}

        <div class="conversation-column conversation-epilogue">
          <file-list
            .runId=${run.id}
            .surface=${surface}
            .filesByRound=${documents.files}
            .failuresByRound=${documents.compileFailures}
          ></file-list>

          ${this.renderUsagePanel(run)}
        </div>
      </div>
      ${
        isLiveRun(run)
          ? this.renderInterruptedDock()
          : html`<div class="conversation-composer-dock">
              <div class="conversation-column">
                ${this.renderInterruptedNotice()} ${this.renderEndedLine(run)}
              </div>
            </div>`
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'workflow-run-content': WorkflowRunContent;
  }
}
