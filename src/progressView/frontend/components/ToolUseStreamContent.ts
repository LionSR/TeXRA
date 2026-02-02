/**
 * Container component for tool-use agent streams.
 *
 * This component receives a narrowed `ToolUseStreamState` type, eliminating
 * the need for type guards inside the component. It renders:
 * - Stream header with toolbar controls
 * - Request panels for approvals and retry prompts (bash, tool edit, etc.)
 * - Todo list for task tracking
 * - Task group list for log display
 * - Usage panel for context window stats
 * - Follow-up input for user messages
 *
 * Uses memoized getters for derived values - only recomputes when
 * dependencies change.
 *
 * @fires toolbar-command - When toolbar actions are triggered
 * @fires permission-action - When user responds to a permission card
 * @fires followup-change - When follow-up text changes
 * @fires followup-send - When follow-up is submitted
 * @fires followup-polish - When polish button is clicked
 * @fires followup-clear - When clear button is clicked
 */

// Third-party imports
import {
  LitElement,
  css,
  html,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { consume } from '@lit/context';
import { customElement, state } from 'lit/decorators.js';
import { createRef, ref, type Ref } from 'lit/directives/ref.js';

// Local imports - progress view utilities
import { getRunGroups, type RunGroup } from '../stateUtils';

// Local imports - progress view contexts
import {
  permissionsContext,
  streamStateContext,
  type StreamContextValue,
} from '../contexts/streamContexts';

// Local imports - progress view events
import { ProgressEvents } from '../events';

// Local imports - progress view store (type-only)
import type { ToolUseStreamState } from '../store';

// Local imports - shared schemas
import type { StreamTabInfo } from '@shared/schemas';

// Local imports - progress view component types
import type { PermissionState } from './PermissionCard';
import type { FollowUpInput } from './FollowUpInput';

// Local imports - sibling components
import './StreamHeader';
import './RequestPanels';
import './TodoList';
import './TaskGroupList';
import './LogList';
import './UsagePanel';
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
  private streamContext?: StreamContextValue;

  @consume({ context: permissionsContext, subscribe: true })
  @state()
  private permissionContext?: PermissionState[];

  // Memoized derived values - updated in willUpdate when deps change
  @state() private filteredPermissions: PermissionState[] = [];
  @state() private runGroups: RunGroup[] = [];

  /** Ref for FollowUpInput - exposed for parent access */
  private followUpRef: Ref<FollowUpInput> = createRef();

  protected override willUpdate(changedProperties: PropertyValues): void {
    if (
      changedProperties.has('streamContext') ||
      changedProperties.has('permissionContext')
    ) {
      this.filteredPermissions = this.computeFilteredPermissions();
      this.runGroups = getRunGroups(this.currentState?.taskGroups ?? []);
    }
  }

  /**
   * Compute filtered prompts for this stream.
   * Only prompts matching this stream's ID (or with no streamId) are shown.
   */
  private get currentStreamInfo(): StreamTabInfo | null {
    return this.streamContext?.streamInfo ?? null;
  }

  private get currentState(): ToolUseStreamState | null {
    const ctx = this.streamContext;
    if (!ctx || !ctx.isToolUse || !ctx.streamState) return null;
    return ctx.streamState as ToolUseStreamState;
  }

  private computeFilteredPermissions(): PermissionState[] {
    const streamId = this.currentStreamInfo?.name;
    if (!streamId) return [];
    const permissions = this.permissionContext ?? [];
    return permissions.filter(
      (permission) =>
        !permission.data.streamId || permission.data.streamId === streamId,
    );
  }

  override render(): TemplateResult {
    const currentState = this.currentState;
    const streamInfo = this.currentStreamInfo;
    if (!currentState || !streamInfo) {
      return html``;
    }

    return html`
      <stream-header
        .stream=${streamInfo}
        .streamState=${currentState}
        .runId=${null}
        .runs=${this.runGroups}
        .yoloActive=${Boolean(currentState.toolEditBypass)}
      ></stream-header>

      <request-panels .permissions=${this.filteredPermissions}></request-panels>

      <todo-list .todos=${currentState.todos}></todo-list>

      <log-list></log-list>

      <usage-panel
        .contextState=${currentState.contextState ?? null}
      ></usage-panel>

      <follow-up-input
        ${ref(this.followUpRef)}
        .visible=${true}
        .value=${currentState.ui.followUpText}
        .queuedMessages=${currentState.queuedFollowUps}
        .shouldFocus=${currentState.ui.shouldFocusFollowUp ?? false}
        .polishedText=${currentState.ui.polishedText ?? null}
        .polishRevision=${currentState.ui.polishRevision ?? 0}
        .transcribedText=${currentState.ui.transcribedText ?? null}
        .recording=${currentState.ui.recording ?? false}
        @focus-complete=${this.handleFocusComplete}
      ></follow-up-input>
    `;
  }

  /**
   * Get the FollowUpInput component ref for imperative operations.
   * Used by parent to apply polished text or focus the input.
   * @returns The FollowUpInput instance, or undefined if not mounted
   */
  getFollowUpRef(): FollowUpInput | undefined {
    return this.followUpRef.value;
  }

  /**
   * Handle focus-complete event from FollowUpInput.
   * Dispatches event to reset the shouldFocusFollowUp state.
   */
  private handleFocusComplete(): void {
    this.dispatchEvent(ProgressEvents.followupFocusComplete());
  }
}
