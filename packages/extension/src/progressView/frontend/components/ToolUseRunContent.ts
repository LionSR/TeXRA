import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

import { acceptsFollowUp } from '@shared/session/surface';
import { BaseRunContent } from './BaseRunContent';
import { conversationContentStyles } from './ConversationContent.styles';
import './RunHeader';
import './TodoList';
import './PlanView';
import './BackgroundTasksPanel';
import './SessionBanners';
import './SessionComposer';

const RUN_ENDED_MESSAGE = 'This run has ended.';

@customElement('tool-use-run-content')
export class ToolUseRunContent extends BaseRunContent {
  static override styles = [
    conversationContentStyles,
    css`
      .conversation-composer-banner--empty {
        padding: 0;
      }
    `,
  ];

  override render(): TemplateResult | typeof nothing {
    const run = this.run;
    if (!run || run.category !== 'toolUse') return nothing;
    // The follow-up line shows while the run can still take one, which is
    // the same rule Send and the run accelerator take (`acceptsFollowUp`).
    const showComposer = acceptsFollowUp(run);
    return html`
      <run-header .run=${run} .view=${this.view}></run-header>
      <div class="conversation-content">
        ${this.renderApprovalDock()}
        <div class="conversation-column conversation-prelude">
          <todo-list .todos=${run.todos} .collapseKey=${run.id}></todo-list>
          <plan-view .plan=${run.plan} .collapseKey=${run.id}></plan-view>
          <background-tasks-panel
            .run=${run}
            .view=${this.view}
            .surface=${this.surface}
            .nowMs=${this.nowMs}
          ></background-tasks-panel>
        </div>
        ${this.renderLog()}
        <div class="conversation-column conversation-epilogue">
          ${this.renderUsagePanel(run)}
        </div>
      </div>
      <div class="conversation-composer-dock">
        <div class="conversation-column">
          <session-banners
            .banners=${this.host.banners}
            .sessionType=${run.category}
          ></session-banners>
          <div
            class=${
              showComposer
                ? 'conversation-composer-banner conversation-composer-banner--empty'
                : 'conversation-composer-banner'
            }
            role="status"
            aria-atomic="true"
          >
            ${showComposer ? nothing : (run.statusDetail ?? RUN_ENDED_MESSAGE)}
          </div>
          ${
            showComposer
              ? html`<session-composer
                  .view=${this.view}
                  .surface=${this.surface}
                  .run=${run}
                  .host=${this.host}
                ></session-composer>`
              : nothing
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
