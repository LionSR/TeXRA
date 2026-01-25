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
 * @fires toolbar-command - When toolbar actions are triggered
 * @fires prompt-action - When user responds to a prompt overlay
 * @fires followup-change - When follow-up text changes
 * @fires followup-send - When follow-up is submitted
 * @fires followup-polish - When polish button is clicked
 * @fires followup-clear - When clear button is clicked
 */

// Third-party imports
import { LitElement, html, css, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { createRef, ref, type Ref } from 'lit/directives/ref.js';

// Local imports - shared schemas
import { getRunGroups } from '../stateUtils';
import type { StreamTabInfo } from '@shared/schemas';

// Local imports - progress view
import type { ToolUseStreamState } from '../store';
import type { PromptState } from './PromptOverlay';
import type { FollowUpInput } from './FollowUpInput';
import type { LogList } from './LogList';

// Local imports - sibling components
import './StreamHeader';
import './PromptOverlay';
import './TodoList';
import './TaskGroupList';
import './UsagePanel';
import './FollowUpInput';

/** Run group info for the run selector */
type RunGroup = { id: string; name: string; startTime: number };

@customElement('tool-use-stream-content')
export class ToolUseStreamContent extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }
  `;

  @property({ type: Object }) state!: ToolUseStreamState;
  @property({ type: Object }) streamInfo!: StreamTabInfo;
  @property({ type: Array }) prompts: PromptState[] = [];

  // Cached derived values - recomputed only when dependencies change
  private _cachedFilteredPrompts: PromptState[] = [];
  private _cachedRunGroups: RunGroup[] = [];
  private _prevStreamId: string | null = null;
  private _prevPrompts: PromptState[] | null = null;
  private _prevTaskGroups: unknown[] | null = null;

  /** Ref for LogList - exposed for parent access via getLogListRef() */
  private logListRef: Ref<LogList> = createRef();
  /** Ref for FollowUpInput - exposed for parent access */
  private followUpRef: Ref<FollowUpInput> = createRef();

  protected willUpdate(changedProperties: PropertyValues<this>): void {
    // Recompute filtered prompts when prompts or streamInfo changes
    if (
      changedProperties.has('prompts') ||
      changedProperties.has('streamInfo')
    ) {
      const streamId = this.streamInfo?.name;
      if (this._prevPrompts !== this.prompts || this._prevStreamId !== streamId) {
        this._cachedFilteredPrompts = this.computeFilteredPrompts();
        this._prevPrompts = this.prompts;
        this._prevStreamId = streamId ?? null;
      }
    }

    // Recompute run groups when state.taskGroups changes
    if (changedProperties.has('state')) {
      const taskGroups = this.state?.taskGroups;
      if (this._prevTaskGroups !== taskGroups) {
        this._cachedRunGroups = getRunGroups(taskGroups ?? []);
        this._prevTaskGroups = taskGroups ?? null;
      }
    }
  }

  render(): TemplateResult {
    return html`
      <stream-header
        .stream=${this.streamInfo}
        .streamState=${this.state}
        .runId=${null}
        .runs=${this._cachedRunGroups}
        .yoloActive=${Boolean(this.state.toolEditBypass)}
      ></stream-header>

      <prompt-overlay
        ?hidden=${this._cachedFilteredPrompts.length === 0}
        .prompt=${this._cachedFilteredPrompts.at(0) ?? null}
      ></prompt-overlay>

      <todo-list .todos=${this.state.todos}></todo-list>

      <task-group-list ${ref(this.logListRef)}></task-group-list>

      <usage-panel
        .contextState=${this.state.contextState ?? null}
      ></usage-panel>

      <follow-up-input
        ${ref(this.followUpRef)}
        .visible=${true}
        .value=${this.state.followUpText}
        .queuedMessages=${this.state.queuedFollowUps}
      ></follow-up-input>
    `;
  }

  /**
   * Compute filtered prompts for this stream.
   * Only prompts matching this stream's ID (or with no streamId) are shown.
   */
  private computeFilteredPrompts(): PromptState[] {
    const streamId = this.streamInfo?.name;
    if (!streamId) return [];
    return this.prompts.filter(
      (prompt) => !prompt.data.streamId || prompt.data.streamId === streamId,
    );
  }

  /**
   * Get the LogList component ref for imperative operations.
   * @returns The LogList instance, or undefined if not mounted
   */
  getLogListRef(): LogList | undefined {
    return this.logListRef.value;
  }

  /**
   * Get the FollowUpInput component ref for imperative operations.
   * Used by parent to apply polished text or focus the input.
   * @returns The FollowUpInput instance, or undefined if not mounted
   */
  getFollowUpRef(): FollowUpInput | undefined {
    return this.followUpRef.value;
  }
}
