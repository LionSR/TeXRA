/** Container component for tool-use agent streams. */

// Third-party imports
import {
  LitElement,
  css,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { consume } from '@lit/context';
import { customElement, state } from 'lit/decorators.js';

// Local imports - progress view
import { filterPermissionsForStream } from '../stateUtils';
import {
  EMPTY_STREAM_CONTEXT,
  permissionsContext,
  streamStateContext,
  type StreamContextValue,
} from '../contexts/streamContexts';
import { ProgressEvents } from '../events';
import type { ToolUseStreamState } from '../store';

// Local imports - types
import type { PermissionState } from './PermissionCard';

// Side-effect imports - sibling components
import './StreamHeader';
import './RequestPanels';
import './TodoList';
import './PlanView';
import './TaskGroupList';
import './LogList';
import './UsagePanel';
import './BackgroundTasksPanel';
import './FollowUpInput';

@customElement('tool-use-stream-content')
export class ToolUseStreamContent extends LitElement {
  static override styles = css`
    :host {
      display: contents;
    }
  `;

  @consume({ context: streamStateContext, subscribe: true })
  @state()
  private streamContext: StreamContextValue = EMPTY_STREAM_CONTEXT;

  @consume({ context: permissionsContext, subscribe: true })
  @state()
  private permissionContext: PermissionState[] = [];

  // Derived values - recomputed in willUpdate() before render.
  private filteredPermissions: PermissionState[] = [];

  protected override willUpdate(changedProperties: PropertyValues): void {
    if (
      changedProperties.has('streamContext') ||
      changedProperties.has('permissionContext')
    ) {
      this.filteredPermissions = filterPermissionsForStream(
        this.permissionContext,
        this.streamContext.streamInfo?.name,
      );
    }
  }

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
      <stream-header
        .stream=${streamInfo}
        .status=${currentState.status}
        .progress=${currentState.conversationProgress}
        .yoloActive=${Boolean(currentState.toolEditBypass)}
        .superYoloActive=${Boolean(currentState.superYoloBypass)}
        .odysseyActive=${Boolean(currentState.odysseyActive)}
      ></stream-header>

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
        .value=${currentState.ui.followUpText}
        .queuedMessages=${currentState.queuedFollowUps}
        .shouldFocus=${currentState.ui.shouldFocusFollowUp}
        .polishedText=${currentState.ui.polishedText}
        .polishRevision=${currentState.ui.polishRevision}
        .transcribedText=${currentState.ui.transcribedText}
        .recording=${currentState.ui.recording}
        @focus-complete=${this.handleFocusComplete}
      ></follow-up-input>
    `;
  }

  private handleFocusComplete(): void {
    this.dispatchEvent(ProgressEvents.followupFocusComplete());
  }
}
