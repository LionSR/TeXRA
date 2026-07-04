import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  AgentCategoryFilter,
  ConversationProgress,
  ContextStateData,
  OutputFileInfo,
  CompileFailure,
  InquiryThreadUpdatedEvent,
  PermissionPayload,
  ProgressPermissionKind,
  ProgressViewPlacement,
  ProgressViewOutboundMessage,
  StreamMetadata,
  StreamPhase,
  StreamSubstate,
  StreamTabId,
  StreamTabInfo,
  Plan,
  TodoItem,
  TokenUsageStats,
} from '@shared/schemas';
import {
  buildStreamInfo,
  buildStreamInfos,
} from '@shared/progressView/backend/streamInfoUtils';
import {
  type ActiveStreamId,
  ProgressViewState,
  type StreamBadgeSnapshot,
} from '@shared/progressView/backend/state/ProgressViewState';
import { buildStreamMetadata } from '@shared/streams/streamMetadata';
import type { GoalStatus } from '@shared/schemas/goal';

export type ProgressViewMessageSender = (
  message: ProgressViewOutboundMessage,
) => void;

/**
 * Extra content to include with log updates.
 * All fields are optional to support incremental updates.
 *
 * NOTE: Status/todos/instruction are sent as separate messages rather than
 * batched here. This ensures critical UI feedback (status) isn't blocked by
 * potentially large log payloads and provides fault isolation.
 */
export interface LogContentExtras {
  /** Workflow output files by round (one run per tab) */
  workflowFiles?: Record<string, OutputFileInfo[]>;
  /** Workflow missing outputs by round */
  workflowMissingOutputs?: Record<string, string[]>;
  /** Workflow compile failures by round */
  workflowCompileFailures?: Record<string, CompileFailure[]>;
  /** Per-run usage map (both workflow and tool-use; frontend derives sum) */
  runUsage?: Record<string, TokenUsageStats>;
  /** Context window utilization state */
  contextState?: ContextStateData;
}

/**
 * Payload for batched stream content hydration (tab switch).
 *
 * Extends {@link LogContentExtras} so the workflow files / usage / context
 * fields shared with incremental log updates have a single definition.
 */
export interface SyncStreamContentPayload extends LogContentExtras {
  stream: StreamTabId | '';
  action?: 'render' | 'clear';
  todos: TodoItem[];
  plan: Plan | null;
  queuedFollowUps: string[];
  agentCategory?: string;
  /** Tab-switch state previously sent by syncActiveStreamState (R2). */
  conversationProgress?: ConversationProgress;
  badges?: StreamBadgeSnapshot;
  parentStreamId?: StreamTabId;
  /** Toggle bypass state (hydrated on tab switch so toggles display correctly). */
  toolEditBypass?: boolean;
  superYoloBypass?: boolean;
  goalActive?: boolean;
  goalStatus?: GoalStatus;
  goalObjective?: string;
}

/**
 * Manages webview updates for the progress view.
 * Provides a clean interface for updating different parts of the webview
 * without coupling business logic to DOM operations.
 * Targets a single active webview at a time (sidebar OR editor panel).
 */
export class WebviewUpdater {
  private readonly streamInfoCache = new Map<StreamTabId, StreamTabInfo>();
  private readonly streamMetadataCache = new Map<StreamTabId, StreamMetadata>();

  constructor(
    private readonly send: ProgressViewMessageSender,
    private readonly hasTarget: () => boolean,
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
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
      streams,
      activeStream,
      agentFilter,
      streamStates,
    });
  }

  updateStreamMetadata(
    state: ProgressViewState,
    streamId: StreamTabId,
    statuses?: Map<string, StreamPhase>,
    substates?: Map<string, StreamSubstate>,
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
      statuses,
      substates,
    );
    this.cacheStreamSnapshot(streamInfo, streamState);

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
      rounds?: { [key: number]: OutputFileInfo[] };
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
      rounds?: { [key: number]: string[] };
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
      rounds?: { [key: number]: CompileFailure[] };
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

  setActiveStream(activeStream: StreamTabId): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream,
    });
  }

  /** Send lightweight delete notification to the current active target. */
  deleteStream(stream: StreamTabId): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
      stream,
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

  /**
   * Send a single batched content sync message combining logs, todos, follow-ups,
   * and instruction. Used on tab switch to replace 4 separate messages with 1.
   */
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
    statuses?: Map<string, StreamPhase>,
    theme?: 'dark' | 'light',
    substates?: Map<string, StreamSubstate>,
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
    const liveStreams = new Set<StreamTabId>();
    for (const streamInfo of streams) {
      liveStreams.add(streamInfo.name);
      const metadata = this.buildStreamMetadataForStream(
        state,
        streamInfo,
        statuses,
        substates,
      );
      streamMetadata[streamInfo.name] = metadata;
      this.cacheStreamSnapshot(streamInfo, metadata);
    }
    this.pruneStreamSnapshotCache(liveStreams);

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
    statuses?: Map<string, StreamPhase>,
    substates?: Map<string, StreamSubstate>,
  ): StreamMetadata {
    const current = state.getStreamState(streamInfo.name);
    return buildStreamMetadata({
      kind: streamInfo.agentCategory,
      status: statuses?.get(streamInfo.name),
      substate: substates?.get(streamInfo.name),
      lastTimestamp: state.streamLogs.getLastTimestamp(streamInfo.name),
      conversationProgress: current?.conversationProgress,
      activeSubagents: current?.activeSubagents,
      finishedSubagentCount: current?.finishedSubagentCount,
      activeProcesses: current?.activeProcesses,
      finishedProcessCount: current?.finishedProcessCount,
    });
  }

  private cacheStreamSnapshot(
    streamInfo: StreamTabInfo,
    metadata: StreamMetadata,
  ): void {
    this.streamInfoCache.set(streamInfo.name, streamInfo);
    this.streamMetadataCache.set(streamInfo.name, metadata);
  }

  private pruneStreamSnapshotCache(liveStreams: Set<StreamTabId>): void {
    for (const streamId of this.streamInfoCache.keys()) {
      if (liveStreams.has(streamId)) continue;
      this.streamInfoCache.delete(streamId);
      this.streamMetadataCache.delete(streamId);
    }
  }
}
