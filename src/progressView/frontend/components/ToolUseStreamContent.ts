/**
 * Container component for tool-use agent streams.
 *
 * This component receives a narrowed `ToolUseStreamState` type, eliminating
 * the need for type guards inside the component. It renders:
 * - Stream header with toolbar controls
 * - Prompt overlay for approval requests (bash, tool edit, etc.)
 * - Todo list for task tracking
 * - Task group list for log display
 * - Usage panel for context window stats
 * - Follow-up input for user messages
 *
 * Uses memoized getters for derived values - only recomputes when
 * dependencies change.
 *
 * @fires toolbar-command - When toolbar actions are triggered
 * @fires prompt-action - When user responds to a prompt overlay
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
import { getRunGroups } from '../stateUtils';
import { isToolUseState, type ToolUseStreamState } from '../store';

// Local imports - progress view contexts
import {
  promptsContext,
  streamStateContext,
  type StreamContextValue,
} from '../contexts/streamContexts';

// Local imports - shared schemas
import type { StreamTabInfo } from '@shared/schemas';

// Local imports - progress view component types
import type { PromptState } from './PromptOverlay';
import type { FollowUpInput } from './FollowUpInput';

// Local imports - sibling components
import './StreamHeader';
import './PromptOverlay';
import './TodoList';
import './TaskGroupList';
import './LogList';
import './UsagePanel';
import './FollowUpInput';

/** Run group info for the run selector */
type RunGroup = { id: string; name: string; startTime: number };

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

  @consume({ context: promptsContext, subscribe: true })
  @state()
  private promptContext?: PromptState[];

  // Memoized derived values - updated in willUpdate when deps change
  @state() private filteredPrompts: PromptState[] = [];
  @state() private runGroups: RunGroup[] = [];

  /** Ref for FollowUpInput - exposed for parent access */
  private followUpRef: Ref<FollowUpInput> = createRef();

  protected willUpdate(changedProperties: PropertyValues): void {
    if (
      changedProperties.has('streamContext') ||
      changedProperties.has('promptContext')
    ) {
      this.filteredPrompts = this.computeFilteredPrompts();
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
    const contextState = this.streamContext?.streamState;
    if (contextState && isToolUseState(contextState)) {
      return contextState;
    }
    return null;
  }

  private get currentPrompts(): PromptState[] {
    return this.promptContext ?? [];
  }

  private computeFilteredPrompts(): PromptState[] {
    const streamId = this.currentStreamInfo?.name;
    if (!streamId) return [];
    return this.currentPrompts.filter(
      (prompt) => !prompt.data.streamId || prompt.data.streamId === streamId,
    );
  }

  render(): TemplateResult {
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

      <prompt-overlay
        ?hidden=${this.filteredPrompts.length === 0}
        .prompt=${this.filteredPrompts.at(0) ?? null}
      ></prompt-overlay>

      <todo-list .todos=${currentState.todos}></todo-list>

      <log-list
        .groups=${currentState.taskGroups}
        .messages=${currentState.logs}
        .isToolUse=${true}
      ></log-list>

      <usage-panel
        .contextState=${currentState.contextState ?? null}
      ></usage-panel>

      <follow-up-input
        ${ref(this.followUpRef)}
        .visible=${true}
        .value=${currentState.followUpText}
        .queuedMessages=${currentState.queuedFollowUps}
        .shouldFocus=${currentState.shouldFocusFollowUp ?? false}
        .polishedText=${currentState.polishedText ?? null}
        .transcribedText=${currentState.transcribedText ?? null}
        .recording=${currentState.recording ?? false}
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
    this.dispatchEvent(
      new CustomEvent('followup-focus-complete', {
        bubbles: true,
        composed: true,
      }),
    );
  }
}
