/** Container component for tool-use agent streams. */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Local imports - progress view
import { ProgressEvents } from '../events';
import { getFollowUpInputTransientState } from '../followUpInputState';
import { BaseStreamContent } from './BaseStreamContent';
import { renderStreamHeader } from './streamHeaderView';
import type { ToolUseStreamState } from '../store';

// Local imports - components

// Side-effect imports - sibling components
import './RequestPanels';
import './TodoList';
import './PlanView';
import './TaskGroupList';
import './LogList';
import './UsagePanel';
import './BackgroundTasksPanel';
import './FollowUpInput';

@customElement('tool-use-stream-content')
export class ToolUseStreamContent extends BaseStreamContent {
  private get currentState(): ToolUseStreamState | null {
    const ctx = this.streamContext;
    if (!ctx.isToolUse || !ctx.streamState) return null;
    return ctx.streamState as ToolUseStreamState;
  }

  override render(): TemplateResult | typeof nothing {
    const currentState = this.currentState;
    const streamInfo = this.streamContext.streamInfo;
    if (!currentState || !streamInfo) {
      return nothing;
    }

    return html`
      ${renderStreamHeader(
        streamInfo,
        currentState,
        this.streamContext.unsupportedCommands,
      )}

      <request-panels .permissions=${this.filteredPermissions}></request-panels>

      <todo-list
        .todos=${currentState.todos}
        .collapseKey=${streamInfo.name}
      ></todo-list>

      <plan-view
        .plan=${currentState.plan}
        .collapseKey=${streamInfo.name}
      ></plan-view>

      <background-tasks-panel
        .activeProcesses=${currentState.activeProcesses}
        .finishedProcessCount=${currentState.finishedProcessCount}
        .activeSubagents=${currentState.activeSubagents}
        .finishedSubagentCount=${currentState.finishedSubagentCount}
      ></background-tasks-panel>

      <log-list></log-list>

      <usage-panel
        .usage=${currentState.sessionUsage ?? null}
        .contextState=${currentState.contextState ?? null}
      ></usage-panel>

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
    `;
  }

  private handleFocusComplete(): void {
    this.dispatchEvent(ProgressEvents.followupFocusComplete());
  }
}
