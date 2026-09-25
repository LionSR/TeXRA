import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

import { acceptsFollowUp } from '@shared/session/sessionView';
import { BaseRunContent } from './BaseRunContent';
import { conversationContentStyles } from './ConversationContent.styles';
import './TodoList';
import './PlanView';
import './BackgroundTasksPanel';
import './SessionComposer';

@customElement('tool-use-run-content')
export class ToolUseRunContent extends BaseRunContent {
  static override styles = conversationContentStyles;

  override render(): TemplateResult | typeof nothing {
    const run = this.run;
    if (!run || run.category !== 'toolUse') return nothing;
    // The follow-up line shows while the run can still take one, which is
    // the same rule Send and the run accelerator take (`acceptsFollowUp`).
    const showComposer = acceptsFollowUp(run, { terminalBacked: true });
    return html`
      <div class="conversation-content">
        ${this.renderApprovalDock()}
        <div class="conversation-column conversation-prelude">
          <todo-list
            .todos=${run.todos}
            .runId=${run.id}
            .surface=${this.surface}
          ></todo-list>
          <plan-view
            .plan=${run.plan}
            .runId=${run.id}
            .surface=${this.surface}
          ></plan-view>
          <background-tasks-panel
            .run=${run}
            .view=${this.view}
            .surface=${this.surface}
          ></background-tasks-panel>
        </div>
        ${this.renderLog()}
        <div class="conversation-column conversation-epilogue">
          ${this.renderUsagePanel(run)}
        </div>
      </div>
      <div class="conversation-composer-dock">
        <div class="conversation-column">
          ${
            showComposer
              ? html`<session-composer
                  .view=${this.view}
                  .surface=${this.surface}
                  .run=${run}
                  .host=${this.host}
                ></session-composer>`
              : this.renderEndedLine(run)
          }
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'tool-use-run-content': ToolUseRunContent;
  }
}
