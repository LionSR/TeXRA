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
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { guard } from 'lit/directives/guard.js';
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

@customElement('tool-use-stream-content')
export class ToolUseStreamContent extends LitElement {
  // Use Light DOM so document-level CSS (logs.css, groups.css, etc.)
  // can style the task-group-list and its content
  protected createRenderRoot(): HTMLElement {
    return this;
  }

  @property({ type: Object }) state!: ToolUseStreamState;
  @property({ type: Object }) streamInfo!: StreamTabInfo;
  @property({ type: Array }) prompts: PromptState[] = [];

  /** Ref for LogList - exposed for parent access via getLogListRef() */
  private logListRef: Ref<LogList> = createRef();
  /** Ref for FollowUpInput - exposed for parent access */
  private followUpRef: Ref<FollowUpInput> = createRef();

  render(): TemplateResult {
    return html`
      <stream-header
        .stream=${this.streamInfo}
        .streamState=${this.state}
        .runId=${null}
        .runs=${guard([this.state?.taskGroups], () =>
          getRunGroups(this.state?.taskGroups ?? []),
        )}
        .yoloActive=${Boolean(this.state.toolEditBypass)}
      ></stream-header>

      <prompt-overlay
        ?hidden=${guard(
          [this.prompts, this.streamInfo?.name],
          () => this.computeFilteredPrompts().length === 0,
        )}
        .prompt=${guard(
          [this.prompts, this.streamInfo?.name],
          () => this.computeFilteredPrompts().at(0) ?? null,
        )}
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
