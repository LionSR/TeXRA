import type { StreamPhaseState } from '@agent/runtime/StreamStatusService';
import {
  buildStreamInfo,
  buildStreamInfos,
  type StreamInfoListSource,
  type StreamInfoSource,
} from '@controllers/session/streamInfoUtils';
import type {
  ActiveStreamId,
  SessionState,
  StreamBadgeSnapshot,
} from '@controllers/session/SessionState';
import type { ApprovalBypassKind } from '@shared/approvalBypassKind';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  CompileFailure,
  ConversationProgress,
  InquiryThreadUpdatedEvent,
  OutputFileInfo,
  PermissionPayload,
  ProgressPermissionKind,
  ProgressViewPlacement,
  ProgressViewOutboundMessage,
  RoundIndexed,
  StreamMetadata,
  StreamPhase,
  StreamStage,
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

/** The state one stream's wire metadata is projected from. */
type StreamMetadataSource = StreamInfoSource &
  Pick<SessionState, 'getStreamState' | 'streamLogs'>;

/** The state a full stream-tabs refresh is projected from. */
type StreamListMetadataSource = StreamMetadataSource &
  StreamInfoListSource &
  Pick<SessionState, 'rotateActiveStream'>;
/**
 * Manages webview updates for the progress view.
 * Provides a clean interface for updating different parts of the webview
 * without coupling business logic to DOM operations.
 * Targets a single active webview at a time (sidebar OR editor panel).
 */
export class WebviewUpdater {
  constructor(
    private readonly send: (message: ProgressViewOutboundMessage) => void,
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

  updateStreamMetadata(
    state: StreamMetadataSource,
    streamId: StreamTabId,
    streamStates?: Map<StreamTabId, StreamPhaseState>,
    options?: { activeStream?: ActiveStreamId },
  ): void {
    const streamInfo = buildStreamInfo(state, streamId);
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
    type: ApprovalBypassKind,
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

  updateStage(stream: StreamTabId, stage: StreamStage): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STAGE,
      stream,
      stage,
    });
  }

  updateStreamBadges(stream: StreamTabId, badges: StreamBadgeSnapshot): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_BADGES,
      stream,
      ...badges,
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
   * Note: This method computes valid active stream via SessionState
   * (single source of truth) and explicitly persists if changed.
   *
   * Use this for structural updates (initial sync, stream add/remove).
   * For incremental updates, prefer targeted messages like:
   * setActiveStream(), updateConversationProgress(), updateStreamBadges(),
   * updateStreamStatus().
   */
  sendStreamMetadata(
    state: StreamListMetadataSource,
    streamStates?: Map<StreamTabId, StreamPhaseState>,
    theme?: 'dark' | 'light',
  ): ActiveStreamId {
    const streams = buildStreamInfos(state);

    // The previously-active stream may have finished while visible —
    // setStreamStatus skipped release for the active tab, so the rotation
    // below is what releases the completed log.
    const activeStream = state.rotateActiveStream(
      streams.map((info) => info.name),
    );

    if (!this.isAvailable()) {
      return activeStream;
    }

    if (theme) {
      this.sendMessage({
        command: PROGRESS_VIEW_COMMANDS.THEME_SET,
        theme,
      });
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

    // Full stream-tabs refresh, carrying the per-stream metadata patch.
    const unsupportedCommands = this.getUnsupportedCommands?.();
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
      streams,
      activeStream,
      unsupportedCommands: unsupportedCommands
        ? [...unsupportedCommands]
        : undefined,
      streamStates: streamMetadata,
    });

    return activeStream;
  }

  isAvailable(): boolean {
    return this.hasTarget();
  }

  private buildStreamMetadataForStream(
    state: StreamMetadataSource,
    streamInfo: StreamTabInfo,
    streamStates?: Map<StreamTabId, StreamPhaseState>,
  ): StreamMetadata {
    const current = state.getStreamState(streamInfo.name);
    const streamState = streamStates?.get(streamInfo.name);
    return buildStreamMetadata({
      category: streamInfo.agentCategory,
      status: streamState?.phase,
      substate: streamState?.substate,
      userFollowUpSupport: streamInfo.userFollowUpSupport,
      lastTimestamp: state.streamLogs.getLastTimestamp(streamInfo.name),
      conversationProgress: current?.conversationProgress,
      stage: current?.stage,
      subagents: current?.subagents,
    });
  }
}
