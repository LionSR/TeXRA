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
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { guard } from 'lit/directives/guard.js';
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

/** Cached derived values for a specific runId */
interface RunDerivedValues {
  instruction: InstructionUpdate | null;
  usage: TokenUsageStats | null;
  files: Record<string, OutputFileInfo[]>;
  hasFiles: boolean;
}

@customElement('workflow-stream-content')
export class WorkflowStreamContent extends LitElement {
  // Use Light DOM so document-level CSS (logs.css, groups.css, etc.)
  // can style the task-group-list and its content
  protected createRenderRoot(): HTMLElement {
    return this;
  }

  @property({ type: Object }) state!: WorkflowStreamState;
  @property({ type: Object }) streamInfo!: StreamTabInfo;
  @property({ type: String }) runId: string | null = null;
  @property({ type: Object }) followupOptions: FollowupOptionsState | null =
    null;

  /** Ref for LogList - exposed for parent access via getLogListRef() */
  private logListRef: Ref<LogList> = createRef();

  render(): TemplateResult {
    return html`
      <stream-header
        .stream=${this.streamInfo}
        .streamState=${this.state}
        .runId=${this.runId}
        .runs=${guard([this.state?.taskGroups], () =>
          getRunGroups(this.state?.taskGroups ?? []),
        )}
        .yoloActive=${false}
      ></stream-header>

      <instruction-panel
        .instruction=${guard(
          [this.runId, this.state],
          () => this.computeRunValues().instruction,
        )}
      ></instruction-panel>

      <task-group-list ${ref(this.logListRef)}></task-group-list>

      <usage-panel
        .usage=${guard(
          [this.runId, this.state],
          () => this.computeRunValues().usage,
        )}
        .contextState=${this.state.contextState ?? null}
      ></usage-panel>

      <file-list
        .filesByRound=${guard(
          [this.runId, this.state],
          () => this.computeRunValues().files,
        )}
        .showRoundHeaders=${true}
      ></file-list>

      <followup-section
        .agentCategory=${this.streamInfo.agentCategory}
        .status=${this.state.status ?? this.streamInfo.status ?? ''}
        .hasOutputFiles=${guard(
          [this.runId, this.state],
          () => this.computeRunValues().hasFiles,
        )}
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
