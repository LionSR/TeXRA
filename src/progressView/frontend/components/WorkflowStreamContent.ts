/**
 * Container component for workflow agent streams.
 * Receives narrowed WorkflowStreamState - no type guards needed inside.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { createRef, ref, type Ref } from 'lit/directives/ref.js';

// Local imports - shared schemas
import { getRunGroups, hasOutputFiles } from '../stateUtils';
import type { StreamTabInfo } from '@shared/schemas';

// Local imports - progress view
import type { FollowupOptionsState, WorkflowStreamState } from '../store';
import type { LogList } from './LogList';

// Local imports - sibling components
import './StreamHeader';
import './InstructionPanel';
import './TaskGroupList';
import './UsagePanel';
import './FileList';
import './FollowupSection';

@customElement('workflow-stream-content')
export class WorkflowStreamContent extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }
  `;

  @property({ type: Object }) state!: WorkflowStreamState;
  @property({ type: Object }) streamInfo!: StreamTabInfo;
  @property({ type: String }) runId: string | null = null;
  @property({ type: Object }) followupOptions: FollowupOptionsState | null =
    null;

  /** Ref for LogList - exposed for parent access via getLogListRef() */
  private logListRef: Ref<LogList> = createRef();

  render(): TemplateResult {
    const instruction =
      this.state.runInstructions[this.runId ?? 'default'] ?? null;
    const usage = this.runId ? (this.state.runUsage[this.runId] ?? null) : null;
    const files = this.runId ? (this.state.runFiles[this.runId] ?? {}) : {};

    return html`
      <stream-header
        .stream=${this.streamInfo}
        .streamState=${this.state}
        .runId=${this.runId}
        .runs=${getRunGroups(this.state.taskGroups)}
        .yoloActive=${false}
      ></stream-header>

      <instruction-panel .instruction=${instruction}></instruction-panel>

      <task-group-list ${ref(this.logListRef)}></task-group-list>

      <usage-panel
        .usage=${usage}
        .contextState=${this.state.contextState ?? null}
      ></usage-panel>

      <file-list .filesByRound=${files} .showRoundHeaders=${true}></file-list>

      <followup-section
        .agentCategory=${this.streamInfo.agentCategory}
        .status=${this.state.status ?? this.streamInfo.status ?? ''}
        .hasOutputFiles=${hasOutputFiles(files)}
        .options=${this.followupOptions}
        .mode=${this.state.followupMode}
        .streamModel=${this.streamInfo.model ?? null}
      ></followup-section>
    `;
  }

  /** Expose LogList ref for parent component */
  getLogListRef(): LogList | undefined {
    return this.logListRef.value;
  }
}
