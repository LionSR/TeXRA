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
  permissionsContext,
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

// Local imports - progress view component types
import type { PermissionState } from './PermissionCard';

// Local imports - sibling components
import './StreamContent';
import type {
  NormalizedStreamData,
  StreamContentSection,
} from './StreamContent';

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

  @consume({ context: permissionsContext, subscribe: true })
  @state()
  private permissionContext?: PermissionState[];

  // Memoized derived values - updated in willUpdate when deps change
  @state() private runGroups: RunGroup[] = [];
  @state() private runValues: RunDerivedValues = {
    instruction: null,
    usage: null,
    files: {},
    hasFiles: false,
  };
  @state() private filteredPermissions: PermissionState[] = [];

  protected override willUpdate(changedProperties: PropertyValues): void {
    if (changedProperties.has('streamContext')) {
      const currentState = this.currentState;
      // Recompute run groups when state changes (taskGroups is inside state)
      this.runGroups = getRunGroups(currentState?.taskGroups ?? []);

      // Recompute run-specific values when runId or state changes
      this.runValues = this.computeRunValues();
    }

    if (
      changedProperties.has('streamContext') ||
      changedProperties.has('permissionContext')
    ) {
      this.filteredPermissions = this.computeFilteredPermissions();
    }
  }

  private get currentStreamInfo(): StreamTabInfo | null {
    return this.streamContext?.streamInfo ?? null;
  }

  private get currentState(): WorkflowStreamState | null {
    const ctx = this.streamContext;
    if (!ctx || ctx.isToolUse || !ctx.streamState) return null;
    return ctx.streamState as WorkflowStreamState;
  }

  private get currentRunId(): string | null {
    return this.streamContext?.runId ?? null;
  }

  private get currentFollowupOptions(): FollowupOptionsState | null {
    return this.streamContext?.followupOptions ?? null;
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

    const sections: StreamContentSection[] = [
      { type: 'instruction', instruction },
      { type: 'requestPanels', permissions: this.filteredPermissions },
      { type: 'logList' },
      {
        type: 'usagePanel',
        usage,
        contextState: state.contextState ?? null,
      },
      {
        type: 'fileList',
        filesByRound: files,
        showRoundHeaders: true,
      },
      {
        type: 'followupSection',
        agentCategory: streamInfo.agentCategory,
        status: state.status ?? streamInfo.status ?? '',
        hasOutputFiles: hasFiles,
        options: this.currentFollowupOptions,
        mode: state.followupMode,
        streamModel: streamInfo.model ?? null,
      },
    ];

    const data: NormalizedStreamData = {
      header: {
        stream: streamInfo,
        streamState: state,
        runId,
        runs: this.runGroups,
        yoloActive: false,
      },
      sections,
    };

    return html` <stream-content .data=${data}></stream-content> `;
  }
}
