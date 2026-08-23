/** Container component for tool-use agent streams. */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Local imports - shared schemas
import {
  isToolUseState,
  STREAM_LIFECYCLE_HELD,
  STREAM_LIFECYCLE_UNCLASSIFIED,
  STREAM_STATUS,
  type StreamTabInfo,
  type ToolUseStreamState,
} from '@shared/schemas';
import { isInFlightPhase } from '@shared/streams/streamStatus';
import {
  STREAM_HELD_ELSEWHERE_MESSAGE,
  streamUnclassifiedMessage,
} from '@shared/streams/streamStatusDisplay';

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
          ${this.renderComposerBanner(currentState, streamInfo)}
          <follow-up-input
            .visible=${composerVisible(currentState, streamInfo)}
            .streamId=${streamInfo.name}
            .transientState=${getFollowUpInputTransientState(streamInfo.name)}
            .value=${currentState.ui.followUpText}
            .queuedMessages=${currentState.queuedFollowUps}
            .shouldFocus=${currentState.ui.shouldFocusFollowUp}
            .sending=${currentState.ui.followUpSending}
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

  private renderComposerBanner(
    state: ToolUseStreamState,
    streamInfo: StreamTabInfo,
  ): TemplateResult | typeof nothing {
    if (composerVisible(state, streamInfo)) return nothing;
    return html`<div class="conversation-composer-banner">
      ${composerBannerMessage(state)}
    </div>`;
  }

  private handleFocusComplete(): void {
    this.dispatchEvent(ProgressEvents.followupFocusComplete());
  }
}

const RUN_ENDED_MESSAGE = 'This run has ended.';

/**
 * The composer exists only where delivery is possible, decided on positive
 * facts: a run live in this process (RUNNING or WAITING), or a tab that has
 * never run (no execution and no transcript history). `ready` alone is not
 * evidence: it is the prefault for "no phase in this process", which is also
 * what settled history and unclassified tabs carry. Everything else shows a
 * read-only banner; Resume is the only way to continue.
 */
function composerVisible(
  state: ToolUseStreamState,
  streamInfo: StreamTabInfo,
): boolean {
  if (isInFlightPhase(state.status)) return true;
  return (
    state.status === STREAM_STATUS.READY &&
    streamInfo.executionId === undefined &&
    state.lastTimestamp === undefined
  );
}

function composerBannerMessage(state: ToolUseStreamState): string {
  switch (state.status) {
    case STREAM_LIFECYCLE_HELD:
      return STREAM_HELD_ELSEWHERE_MESSAGE;
    case STREAM_LIFECYCLE_UNCLASSIFIED:
      return streamUnclassifiedMessage(state.statusDetail);
    default:
      return RUN_ENDED_MESSAGE;
  }
}
