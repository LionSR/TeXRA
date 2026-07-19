import type { StreamPhaseState } from '@agent/runtime/StreamStatusService';
import {
  type ActiveStreamId,
  ProgressViewState,
  type StreamBadgeSnapshot,
} from '@controllers/progressView/backend/state/ProgressViewState';
import {
  buildStreamInfo,
  buildStreamInfos,
} from '@controllers/progressView/backend/streamInfoUtils';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  AgentCategoryFilter,
  CompileFailure,
  ConversationProgress,
  InquiryThreadUpdatedEvent,
  OutputFileInfo,
  PermissionPayload,
  ProgressPermissionKind,
  ProgressViewPlacement,
  ProgressViewOutboundMessage,
  RoundIndexed,
  RoundStage,
  StreamMetadata,
  StreamPhase,
  StreamSubstate,
  StreamTabId,
  StreamTabInfo,
  Plan,
  TodoItem,
  SyncStreamContentPayload,
  TokenUsageStats,
} from '@shared/schemas';
import { buildStreamMetadata } from '@shared/streams/streamMetadata';
import type { GoalStatus } from '@shared/schemas/goal';

export type ProgressViewMessageSender = (
  message: ProgressViewOutboundMessage,
) => void;

/**
 * Manages webview updates for the progress view.
 * Provides a clean interface for updating different parts of the webview
 * without coupling business logic to DOM operations.
 * Targets a single active webview at a time (sidebar OR editor panel).
 */
export class WebviewUpdater {
  constructor(
    private readonly send: ProgressViewMessageSender,
    private readonly hasTarget: () => boolean,
    /**
     * Commands this host's inbound registry declares `unsupported(...)`
     * (see `unsupportedCommands` in `@shared/utils/dispatcher`). Included
     * with every stream-tabs update so the frontend's capability gating
     * (e.g. StreamHeader) stays derived from the registry, never a
     * host-check ternary.
     */
    private readonly getUnsupportedCommands?: () => readonly string[],
  ) {}

  /**
   * Helper to send typed messages to the current active webview target.
   * Uses ProgressViewOutboundMessage union type for compile-time safety.
   */
  private sendMessage(message: ProgressViewOutboundMessage): void {
    if (!this.hasTarget()) return;
    this.send(message);
  }

  /**
   * Update stream tabs in the webview.
   * Optionally includes lightweight stream metadata (backend-owned fields only).
   */
  updateStreams(
    streams: StreamTabInfo[],
    activeStream: ActiveStreamId,
    agentFilter: AgentCategoryFilter,
    streamStates?: Record<StreamTabId, StreamMetadata>,
  ): void {
    const unsupportedCommands = this.getUnsupportedCommands?.();
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
      streams,
      activeStream,
      unsupportedCommands: unsupportedCommands
        ? [...unsupportedCommands]
        : undefined,
      agentFilter,
      streamStates,
    });
  }

  updateStreamMetadata(
    state: ProgressViewState,
    streamId: StreamTabId,
    streamStates?: Map<StreamTabId, StreamPhaseState>,
    options?: {
      activeStream?: ActiveStreamId;
      agentFilter?: AgentCategoryFilter;
    },
  ): void {
    const streamInfo = buildStreamInfo(state, streamId, 'all');
    if (!streamInfo) return;

    const streamState = this.buildStreamMetadataForStream(
      state,
      streamInfo,
      streamStates,
    );

    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
      streamInfo,
      streamState,
      activeStream: options?.activeStream,
      agentFilter: options?.agentFilter,
    });
  }

  updateFiles(
    stream: StreamTabId,
    payload: {
      rounds?: RoundIndexed<OutputFileInfo>;
      reset?: boolean;
    },
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_FILES,
      stream,
      ...payload,
    });
  }

  updateMissingOutputs(
    stream: StreamTabId,
    payload: {
      rounds?: RoundIndexed<string>;
      reset?: boolean;
    },
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS,
      stream,
      ...payload,
    });
  }

  updateCompileFailures(
    stream: StreamTabId,
    payload: {
      rounds?: RoundIndexed<CompileFailure>;
      reset?: boolean;
    },
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_COMPILE_FAILURES,
      stream,
      ...payload,
    });
  }

  showPermission(permission: PermissionPayload): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
      action: 'show',
      permission,
    });
  }

  resolvePermission(kind: ProgressPermissionKind, id: string): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
      action: 'resolve',
      kind,
      id,
    });
  }

  updateBypassState(
    stream: StreamTabId,
    type: 'toolEdit' | 'superYolo',
    bypassActive: boolean,
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_BYPASS,
      stream,
      type,
      bypassActive,
    });
  }

  /** Notify the frontend that this stream's goal state changed. */
  updateGoalActive(
    stream: StreamTabId,
    active: boolean,
    details?: { status?: GoalStatus; objective?: string },
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.GOAL_ACTIVE_UPDATED,
      stream,
      active,
      ...(details?.status ? { status: details.status } : {}),
      ...(details?.objective ? { objective: details.objective } : {}),
    });
  }

  /** Update usage for a single run (incremental). */
  updateRunUsage(
    stream: StreamTabId,
    runId: string,
    usage: TokenUsageStats,
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE,
      stream,
      runId,
      usage,
    });
  }

  updateTheme(theme: 'dark' | 'light'): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.THEME_SET,
      theme,
    });
  }

  setPlacement(placement: ProgressViewPlacement): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.SET_PLACEMENT,
      placement,
    });
  }

  /**
   * Update a single stream's status in the stream tabs.
   * More efficient than updateStreams when only status changed.
   * @param lastTimestamp - Optional timestamp for updating "last activity" display
   */
  updateStreamStatus(
    stream: StreamTabId,
    status: StreamPhase,
    lastTimestamp?: number,
    substate?: StreamSubstate,
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS,
      stream,
      status,
      lastTimestamp,
      ...(substate ? { substate } : {}),
    });
  }

  updateStreamDescription(stream: StreamTabId, description: string): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_DESCRIPTION,
      stream,
      description,
    });
  }

  setActiveStream(activeStream: ActiveStreamId): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream,
    });
  }

  updateConversationProgress(
    stream: StreamTabId,
    progress: ConversationProgress,
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_CONVERSATION_PROGRESS,
      stream,
      progress,
    });
  }

  updateRoundStage(stream: StreamTabId, roundStage: RoundStage): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_ROUND_STAGE,
      stream,
      roundStage,
    });
  }

  updateStreamBadges(stream: StreamTabId, badges: StreamBadgeSnapshot): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_BADGES,
      stream,
      ...badges,
    });
  }

  updateProcessOutput(
    stream: StreamTabId,
    executionId: string,
    stdout: string,
    stderr: string,
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_PROCESS_OUTPUT,
      stream,
      executionId,
      stdout,
      stderr,
    });
  }

  syncInquiryThreads(threads: InquiryThreadUpdatedEvent[]): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.SYNC_INQUIRY_THREADS,
      threads,
    });
  }

  updateInquiryThread(thread: InquiryThreadUpdatedEvent): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_INQUIRY_THREAD,
      thread,
    });
  }

  updateParentStream(
    stream: StreamTabId,
    parentStreamId: StreamTabId | undefined,
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_PARENT_STREAM,
      stream,
      parentStreamId,
    });
  }

  updateTodos(stream: StreamTabId, todos: TodoItem[]): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_TODOS,
      stream,
      todos,
    });
  }

  updatePlan(stream: StreamTabId, plan: Plan | null): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_PLAN,
      stream,
      plan,
    });
  }

  updateQueuedFollowUps(stream: StreamTabId, messages: string[]): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_QUEUED_FOLLOW_UPS,
      stream,
      messages,
    });
  }

  /** Sends one complete, kind-specific content snapshot for a stream tab. */
  sendSyncStreamContent(payload: SyncStreamContentPayload): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
      ...payload,
    });
  }

  /**
   * Update stream metadata and theme for the webview.
   * Returns the active stream after applying the update.
   *
   * Note: This method computes valid active stream via ProgressViewState
   * (single source of truth) and explicitly persists if changed.
   *
   * Use this for structural updates (initial sync, filter changes, stream add/remove).
   * For incremental updates, prefer targeted messages like:
   * setActiveStream(), updateConversationProgress(), updateStreamBadges(),
   * updateParentStream(), updateStreamStatus().
   */
  sendStreamMetadata(
    state: ProgressViewState,
    streamStates?: Map<StreamTabId, StreamPhaseState>,
    theme?: 'dark' | 'light',
  ): ActiveStreamId {
    // Send every stream so streamById stays comprehensive for consumers like
    // BackgroundTasksPanel that need to render cross-filter subagent children
    // (e.g., tool-use subagents of a workflow orchestrator under a workflow
    // filter). The frontend still applies `state.agentCategoryFilter` at the
    // sidebar display layer via `tabStreams$`.
    const streams = buildStreamInfos(state);

    // Active-stream validation still respects the filter so a filter change
    // auto-rotates to a matching tab instead of leaving a hidden tab selected.
    const filter = state.agentCategoryFilter;
    const selectableNames = streams
      .filter((info) => filter === 'all' || info.agentCategory === filter)
      .map((info) => info.name);
    // When the filter excludes every stream, there's no valid tab to keep
    // active; pickValidActiveStream's `[] || current` fallback would sticky
    // on a hidden-category stream, so clear instead.
    const activeStream =
      selectableNames.length === 0
        ? ''
        : state.pickValidActiveStream(selectableNames);
    const previousActive = state.activeStream;
    if (activeStream !== previousActive) {
      state.activeStream = activeStream;
      // The previously-active stream may have finished while visible —
      // setStreamStatus skipped release for the active tab, and the
      // filter-driven switch path doesn't go through setActiveStream.
      // Release here so the completed log doesn't stay pinned.
      if (previousActive && previousActive !== activeStream) {
        state.releasePreviousActive(previousActive);
      }
    }

    if (!this.isAvailable()) {
      return activeStream;
    }

    if (theme) {
      this.updateTheme(theme);
    }

    // Send lightweight metadata — only backend-owned fields the frontend merges.
    const streamMetadata: Record<StreamTabId, StreamMetadata> = {};
    for (const streamInfo of streams) {
      streamMetadata[streamInfo.name] = this.buildStreamMetadataForStream(
        state,
        streamInfo,
        streamStates,
      );
    }

    this.updateStreams(
      streams,
      activeStream,
      state.agentCategoryFilter,
      streamMetadata,
    );

    return activeStream;
  }

  isAvailable(): boolean {
    return this.hasTarget();
  }

  private buildStreamMetadataForStream(
    state: ProgressViewState,
    streamInfo: StreamTabInfo,
    streamStates?: Map<StreamTabId, StreamPhaseState>,
  ): StreamMetadata {
    const current = state.getStreamState(streamInfo.name);
    const streamState = streamStates?.get(streamInfo.name);
    return buildStreamMetadata({
      kind: streamInfo.agentCategory,
      status: streamState?.phase,
      substate: streamState?.substate,
      lastTimestamp: state.streamLogs.getLastTimestamp(streamInfo.name),
      conversationProgress: current?.conversationProgress,
      roundStage: current?.roundStage,
      activeSubagents: current?.activeSubagents,
      finishedSubagentCount: current?.finishedSubagentCount,
      activeProcesses: current?.activeProcesses,
      finishedProcessCount: current?.finishedProcessCount,
    });
  }
}
