import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

import type { StreamView } from '@shared/session/sessionView';
import { BaseStreamContent } from './BaseStreamContent';
import { conversationContentStyles } from './ConversationContent.styles';
import './StreamHeader';
import './TodoList';
import './PlanView';
import './BackgroundTasksPanel';
import './SessionComposer';

const RUN_ENDED_MESSAGE = 'This run has ended.';

/** The follow-up line shows while the run can still take one. */
function composerVisible(stream: StreamView): boolean {
  if (stream.followUpSupport === 'unsupported' || stream.readOnly) return false;
  if (stream.group === 'running' || stream.group === 'waiting') return true;
  return stream.status === 'ready' && stream.lastTimestamp === null;
}

@customElement('tool-use-stream-content')
export class ToolUseStreamContent extends BaseStreamContent {
  static override styles = [
    conversationContentStyles,
    css`
      .conversation-composer-banner--empty {
        padding: 0;
      }
    `,
  ];

  override render(): TemplateResult | typeof nothing {
    const stream = this.stream;
    if (!stream || stream.category !== 'toolUse') return nothing;
    const showComposer = composerVisible(stream);
    return html`
      <stream-header .stream=${stream} .view=${this.view}></stream-header>
      <div class="conversation-content">
        ${this.renderApprovalDock()}
        <div class="conversation-column conversation-prelude">
          <todo-list
            .todos=${stream.todos}
            .collapseKey=${stream.id}
          ></todo-list>
          <plan-view .plan=${stream.plan} .collapseKey=${stream.id}></plan-view>
          <background-tasks-panel
            .stream=${stream}
            .view=${this.view}
            .nowMs=${this.nowMs}
          ></background-tasks-panel>
        </div>
        ${this.renderLog()}
        <div class="conversation-column conversation-epilogue">
          ${this.renderUsagePanel(stream)}
        </div>
      </div>
      <div class="conversation-composer-dock">
        <div class="conversation-column">
          <div
            class=${
              showComposer
                ? 'conversation-composer-banner conversation-composer-banner--empty'
                : 'conversation-composer-banner'
            }
            role="status"
            aria-atomic="true"
          >
            ${showComposer ? nothing : (stream.statusDetail ?? RUN_ENDED_MESSAGE)}
          </div>
          ${
            showComposer
              ? html`<session-composer
                  .view=${this.view}
                  .surface=${this.surface}
                  .stream=${stream}
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
    'tool-use-stream-content': ToolUseStreamContent;
  }
}
