/** Container component for tool-use agent streams. */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Local imports - shared schemas
import { isToolUseState, type ToolUseStreamState } from '@shared/schemas';

// Local imports - progress view
import { ProgressEvents } from '../events';
import { getFollowUpInputTransientState } from '../followUpInputState';
import { BaseStreamContent } from './BaseStreamContent';
import { conversationContentStyles } from './ConversationContent.styles';

// Side-effect import - register the <stream-header> element
import './StreamHeader';

// Side-effect imports - sibling components
import './TodoList';
import './PlanView';
import './TaskGroupList';
import './BackgroundTasksPanel';
import './FollowUpInput';

@customElement('tool-use-stream-content')
export class ToolUseStreamContent extends BaseStreamContent {
  static override styles = conversationContentStyles;

  private get currentState(): ToolUseStreamState | null {
    const { streamState } = this.streamContext;
    return streamState && isToolUseState(streamState) ? streamState : null;
  }

  override render(): TemplateResult | typeof nothing {
    const currentState = this.currentState;
    const streamInfo = this.streamContext.streamInfo;
    if (!currentState || !streamInfo) {
      return nothing;
    }

    return html`
      <stream-header
        .stream=${streamInfo}
        .state=${currentState}
        .unsupportedCommands=${this.streamContext.unsupportedCommands}
      ></stream-header>

      <div class="conversation-content">
        ${this.renderApprovalDock()}

        <div class="conversation-column conversation-prelude">
          <todo-list
            .todos=${currentState.todos}
            .collapseKey=${streamInfo.name}
          ></todo-list>

          <plan-view
            .plan=${currentState.plan}
            .collapseKey=${streamInfo.name}
          ></plan-view>

          <background-tasks-panel
            .subagents=${currentState.subagents}
          ></background-tasks-panel>
        </div>

        ${this.renderLog()}

        <div class="conversation-column conversation-epilogue">
          ${this.renderUsagePanel(currentState.runUsage, currentState.contextState)}
        </div>
      </div>

      <div class="conversation-composer-dock">
        <div class="conversation-column">
          <follow-up-input
            .visible=${true}
            .streamId=${streamInfo.name}
            .transientState=${getFollowUpInputTransientState(streamInfo.name)}
            .value=${currentState.ui.followUpText}
            .queuedMessages=${currentState.queuedFollowUps}
            .shouldFocus=${currentState.ui.shouldFocusFollowUp}
            .polishedText=${currentState.ui.polishedText}
            .polishRevision=${currentState.ui.polishRevision}
            .transcribedText=${currentState.ui.transcribedText}
            .recording=${currentState.ui.recording}
            .unsupportedCommands=${this.streamContext.unsupportedCommands}
            @focus-complete=${this.handleFocusComplete}
          ></follow-up-input>
        </div>
      </div>
    `;
  }

  private handleFocusComplete(): void {
    this.dispatchEvent(ProgressEvents.followupFocusComplete());
  }
}
