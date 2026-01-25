/**
 * Container component for tool-use agent streams.
 * Receives narrowed ToolUseStreamState - no type guards needed inside.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
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

  /** Ref for LogList - exposed for parent access via getLogListRef() */
  private logListRef: Ref<LogList> = createRef();
  /** Ref for FollowUpInput - exposed for parent access */
  private followUpRef: Ref<FollowUpInput> = createRef();

  render(): TemplateResult {
    const filteredPrompts = this.getFilteredPrompts();

    return html`
      <stream-header
        .stream=${this.streamInfo}
        .streamState=${this.state}
        .runId=${null}
        .runs=${getRunGroups(this.state.taskGroups)}
        .yoloActive=${Boolean(this.state.toolEditBypass)}
      ></stream-header>

      <prompt-overlay
        ?hidden=${filteredPrompts.length === 0}
        .prompt=${filteredPrompts.at(0) ?? null}
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
   * Filter prompts to only show those matching this stream.
   * Prompts with empty streamId are shown for all streams.
   */
  private getFilteredPrompts(): PromptState[] {
    const streamId = this.streamInfo.name;
    return this.prompts.filter(
      (prompt) => !prompt.data.streamId || prompt.data.streamId === streamId,
    );
  }

  /** Expose LogList ref for parent component */
  getLogListRef(): LogList | undefined {
    return this.logListRef.value;
  }

  /** Expose FollowUpInput ref for parent component */
  getFollowUpRef(): FollowUpInput | undefined {
    return this.followUpRef.value;
  }
}
