/** Container component for workflow agent streams. */

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
import { createRef, ref, type Ref } from 'lit/directives/ref.js';

// Local imports - progress view
import type {
  InstructionUpdate,
  OutputFileInfo,
  TokenUsageStats,
} from '@shared/schemas';
import {
  filterPermissionsForStream,
  getRunGroups,
  hasOutputFiles,
  type RunGroup,
} from '../stateUtils';
import {
  EMPTY_STREAM_CONTEXT,
  permissionsContext,
  streamStateContext,
  type StreamContextValue,
} from '../contexts/streamContexts';
import type { FollowupOptionsState, WorkflowStreamState } from '../store';

// Local imports - types
import type { BackgroundTasksPanel } from './BackgroundTasksPanel';
import type { PermissionState } from './PermissionCard';

// Side-effect imports - sibling components
import './StreamHeader';
import './InstructionPanel';
import './TaskGroupList';
import './LogList';
import './UsagePanel';
import './FileList';
import './FollowupSection';
import './BackgroundTasksPanel';
import './RequestPanels';

/** Derived values for the currently selected run. */
interface RunDerivedValues {
  instruction: InstructionUpdate | null;
  usage: TokenUsageStats | null;
  files: Record<string, OutputFileInfo[]>;
  hasFiles: boolean;
}

const EMPTY_RUN_VALUES: RunDerivedValues = {
  instruction: null,
  usage: null,
  files: {},
  hasFiles: false,
};

@customElement('workflow-stream-content')
export class WorkflowStreamContent extends LitElement {
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
  // Not @state(): always derived from streamContext/permissionContext (avoids double-render).
  private runGroups: RunGroup[] = [];
  private runValues: RunDerivedValues = EMPTY_RUN_VALUES;
  private backgroundTasksRef: Ref<BackgroundTasksPanel> = createRef();
  private filteredPermissions: PermissionState[] = [];

  protected override willUpdate(changedProperties: PropertyValues): void {
    if (changedProperties.has('streamContext')) {
      const currentState = this.currentState;
      this.runGroups = currentState
        ? getRunGroups(currentState.taskGroups)
        : [];
      this.runValues = this.computeRunValues(currentState);
    }

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

  private get currentState(): WorkflowStreamState | null {
    const ctx = this.streamContext;
    if (ctx.isToolUse || !ctx.streamState) return null;
    return ctx.streamState as WorkflowStreamState;
  }

  /** Compute all run-specific derived values at once. */
  private computeRunValues(
    state: WorkflowStreamState | null,
  ): RunDerivedValues {
    if (!state) return EMPTY_RUN_VALUES;

    const runId = this.streamContext.runId;
    const runKey = runId ?? 'default';
    const instruction = state.runInstructions[runKey] ?? null;
    const usage = runId ? (state.runUsage[runId] ?? null) : null;
    const files = runId ? (state.runFiles[runId] ?? {}) : {};

    return { instruction, usage, files, hasFiles: hasOutputFiles(files) };
  }

  override render(): TemplateResult | typeof nothing {
    const { instruction, usage, files, hasFiles } = this.runValues;
    const streamInfo = this.streamContext.streamInfo;
    const state = this.currentState;
    const runId = this.streamContext.runId;

    if (!streamInfo || !state) {
      return nothing;
    }

    return html`
      <stream-header
        .stream=${streamInfo}
        .streamState=${state}
        .runId=${runId}
        .runs=${this.runGroups}
        .yoloActive=${false}
        @background-tasks-toggle=${this.handleBackgroundTasksToggle}
      ></stream-header>

      <instruction-panel .instruction=${instruction}></instruction-panel>

      <request-panels .permissions=${this.filteredPermissions}></request-panels>

      <background-tasks-panel
        ${ref(this.backgroundTasksRef)}
        .activeProcesses=${state.activeProcesses}
        .finishedProcessCount=${state.finishedProcessCount}
        .activeSubagents=${state.activeSubagents}
        .finishedSubagentCount=${state.finishedSubagentCount}
        .open=${state.activeProcesses.length > 0 ||
        state.activeSubagents.length > 0}
      ></background-tasks-panel>

      <log-list></log-list>

      <usage-panel
        .usage=${usage}
        .contextState=${state.contextState ?? null}
      ></usage-panel>

      <file-list .filesByRound=${files} .showRoundHeaders=${true}></file-list>

      <followup-section
        .agentCategory=${streamInfo.agentCategory}
        .status=${state.status}
        .hasOutputFiles=${hasFiles}
        .options=${this.streamContext.followupOptions}
        .mode=${state.followupMode}
        .streamModel=${streamInfo.model ?? null}
      ></followup-section>
    `;
  }

  private handleBackgroundTasksToggle(): void {
    const panel = this.backgroundTasksRef.value;
    if (!panel) return;
    panel.open = !panel.open;
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}
