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
 * Uses memoized state for derived values - only recomputes when
 * dependencies change.
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
  css,
  html,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { consume } from '@lit/context';
import { customElement, state } from 'lit/decorators.js';

// Local imports - progress view utilities
import { getRunGroups, hasOutputFiles, type RunGroup } from '../stateUtils';

// Local imports - progress view contexts
import {
  getWorkflowState,
  streamStateContext,
  type StreamContextValue,
} from '../contexts/streamContexts';

// Local imports - progress view store (type-only)
import type { FollowupOptionsState, WorkflowStreamState } from '../store';

// Local imports - shared schemas
import type {
  InstructionUpdate,
  OutputFileInfo,
  StreamTabInfo,
  TokenUsageStats,
} from '@shared/schemas';

// Local imports - sibling components
import './StreamHeader';
import './InstructionPanel';
import './TaskGroupList';
import './LogList';
import './UsagePanel';
import './FileList';
import './FollowupSection';

/** Derived values for the currently selected run */
interface RunDerivedValues {
  instruction: InstructionUpdate | null;
  usage: TokenUsageStats | null;
  files: Record<string, OutputFileInfo[]>;
  hasFiles: boolean;
}

@customElement('workflow-stream-content')
export class WorkflowStreamContent extends LitElement {
  static override styles = css`
    :host {
      display: contents;
    }
  `;

  @consume({ context: streamStateContext, subscribe: true })
  @state()
  private streamContext?: StreamContextValue;

  // Memoized derived values - updated in willUpdate when deps change
  @state() private runGroups: RunGroup[] = [];
  @state() private runValues: RunDerivedValues = {
    instruction: null,
    usage: null,
    files: {},
    hasFiles: false,
  };

  protected override willUpdate(changedProperties: PropertyValues): void {
    if (changedProperties.has('streamContext')) {
      const currentState = this.currentState;
      // Recompute run groups when state changes (taskGroups is inside state)
      this.runGroups = getRunGroups(currentState?.taskGroups ?? []);

      // Recompute run-specific values when runId or state changes
      this.runValues = this.computeRunValues();
    }
  }

  private get currentStreamInfo(): StreamTabInfo | null {
    return this.streamContext?.streamInfo ?? null;
  }

  private get currentState(): WorkflowStreamState | null {
    if (!this.streamContext) return null;
    return getWorkflowState(this.streamContext);
  }

  private get currentRunId(): string | null {
    return this.streamContext?.runId ?? null;
  }

  private get currentFollowupOptions(): FollowupOptionsState | null {
    return this.streamContext?.followupOptions ?? null;
  }

  /**
   * Compute all run-specific derived values at once.
   * This avoids multiple object lookups during render.
   */
  private computeRunValues(): RunDerivedValues {
    const state = this.currentState;
    if (!state) {
      return { instruction: null, usage: null, files: {}, hasFiles: false };
    }

    const runId = this.currentRunId;
    const runKey = runId ?? 'default';
    const instruction = state.runInstructions[runKey] ?? null;
    const usage = runId ? (state.runUsage[runId] ?? null) : null;
    const files = runId ? (state.runFiles[runId] ?? {}) : {};
    const hasFiles = hasOutputFiles(files);

    return { instruction, usage, files, hasFiles };
  }

  override render(): TemplateResult {
    const { instruction, usage, files, hasFiles } = this.runValues;
    const streamInfo = this.currentStreamInfo;
    const state = this.currentState;
    const runId = this.currentRunId;

    if (!streamInfo || !state) {
      return html``;
    }

    return html`
      <stream-header
        .stream=${streamInfo}
        .streamState=${state}
        .runId=${runId}
        .runs=${this.runGroups}
        .yoloActive=${false}
      ></stream-header>

      <instruction-panel .instruction=${instruction}></instruction-panel>

      <log-list
        .groups=${state.taskGroups}
        .messages=${state.logs}
        .activeRunId=${runId}
        .isToolUse=${false}
      ></log-list>

      <usage-panel
        .usage=${usage}
        .contextState=${state.contextState ?? null}
      ></usage-panel>

      <file-list .filesByRound=${files} .showRoundHeaders=${true}></file-list>

      <followup-section
        .agentCategory=${streamInfo.agentCategory}
        .status=${state.status ?? streamInfo.status ?? ''}
        .hasOutputFiles=${hasFiles}
        .options=${this.currentFollowupOptions}
        .mode=${state.followupMode}
        .streamModel=${streamInfo.model ?? null}
      ></followup-section>
    `;
  }
}
