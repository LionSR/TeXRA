/**
 * Container component for workflow agent streams.
 *
 * This component receives a narrowed `WorkflowStreamState` type, eliminating
 * the need for type guards inside the component. It renders:
 * - Stream header with run selector and toolbar controls
 * - Instruction panel showing the current run's instruction
 * - Task group list for log display
 * - Usage panel for token stats per run
 * - File list showing output files by round
 * - Follow-up section for chat/iterate/compare modes
 *
 * @fires toolbar-command - When toolbar actions are triggered
 * @fires run-selected - When a different run is selected
 * @fires file-action - When a file action (open, copy, etc.) is triggered
 * @fires followup-request-options - When follow-up options are requested
 * @fires followup-mode-change - When follow-up mode changes
 * @fires followup-setup - When follow-up setup is triggered
 * @fires followup-run - When follow-up is executed
 */

// Third-party imports
import {
  LitElement,
  html,
  css,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { createRef, ref, type Ref } from 'lit/directives/ref.js';

// Local imports - shared schemas
import { getRunGroups, hasOutputFiles } from '../stateUtils';
import type {
  InstructionUpdate,
  OutputFileInfo,
  StreamTabInfo,
  TokenUsageStats,
} from '@shared/schemas';

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

/** Run group info for the run selector */
type RunGroup = { id: string; name: string; startTime: number };

/** Cached derived values for a specific runId */
interface RunDerivedValues {
  instruction: InstructionUpdate | null;
  usage: TokenUsageStats | null;
  files: Record<string, OutputFileInfo[]>;
  hasFiles: boolean;
}

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

  // Cached derived values - recomputed only when dependencies change
  private _cachedRunGroups: RunGroup[] = [];
  private _cachedRunValues: RunDerivedValues = {
    instruction: null,
    usage: null,
    files: {},
    hasFiles: false,
  };
  private _prevTaskGroups: unknown[] | null = null;
  private _prevRunId: string | null = null;
  private _prevState: WorkflowStreamState | null = null;

  /** Ref for LogList - exposed for parent access via getLogListRef() */
  private logListRef: Ref<LogList> = createRef();

  protected willUpdate(changedProperties: PropertyValues<this>): void {
    // Recompute run groups when state.taskGroups changes
    if (changedProperties.has('state')) {
      const taskGroups = this.state?.taskGroups;
      if (this._prevTaskGroups !== taskGroups) {
        this._cachedRunGroups = getRunGroups(taskGroups ?? []);
        this._prevTaskGroups = taskGroups ?? null;
      }
    }

    // Recompute run-specific values when runId or state changes
    if (changedProperties.has('runId') || changedProperties.has('state')) {
      if (this._prevRunId !== this.runId || this._prevState !== this.state) {
        this._cachedRunValues = this.computeRunValues();
        this._prevRunId = this.runId;
        this._prevState = this.state;
      }
    }
  }

  render(): TemplateResult {
    const { instruction, usage, files, hasFiles } = this._cachedRunValues;

    return html`
      <stream-header
        .stream=${this.streamInfo}
        .streamState=${this.state}
        .runId=${this.runId}
        .runs=${this._cachedRunGroups}
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
        .hasOutputFiles=${hasFiles}
        .options=${this.followupOptions}
        .mode=${this.state.followupMode}
        .streamModel=${this.streamInfo.model ?? null}
      ></followup-section>
    `;
  }

  /**
   * Compute all run-specific derived values at once.
   * This avoids multiple object lookups during render.
   */
  private computeRunValues(): RunDerivedValues {
    const runKey = this.runId ?? 'default';
    const instruction = this.state.runInstructions[runKey] ?? null;
    const usage = this.runId ? (this.state.runUsage[this.runId] ?? null) : null;
    const files = this.runId ? (this.state.runFiles[this.runId] ?? {}) : {};
    const hasFiles = hasOutputFiles(files);

    return { instruction, usage, files, hasFiles };
  }

  /**
   * Get the LogList component ref for imperative operations.
   * @returns The LogList instance, or undefined if not mounted
   */
  getLogListRef(): LogList | undefined {
    return this.logListRef.value;
  }
}
