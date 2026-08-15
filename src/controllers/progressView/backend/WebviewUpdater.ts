import type {
  ProjectedStreamMetadata,
  ProjectedStreamRoster,
} from '@controllers/progressView/backend/ProgressStreamProjectionBuilder';
import type { StreamBadgeSnapshot } from '@controllers/session/SessionState';
import type { PresentedStreamId } from '@controllers/session/SessionRendererPort';
import type { ApprovalBypassKind } from '@shared/approvalBypassKind';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  CompileFailure,
  ConversationProgress,
  GoalStatus,
  InquiryThreadUpdatedEvent,
  OutputFileInfo,
  PermissionPayload,
  Plan,
  ProgressPermissionKind,
  ProgressViewOutboundMessage,
  ProgressViewPlacement,
  RoundIndexed,
  StreamPhase,
  StreamStage,
  StreamSubstate,
  StreamTabId,
  SyncStreamContentPayload,
  TodoItem,
  TokenUsageStats,
} from '@shared/schemas';
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
    projection: ProjectedStreamMetadata,
    options?: { activeStream?: PresentedStreamId },
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
      ...projection,
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

  /** Push the host theme alone — theme flips need no metadata rebuild. */
  setTheme(theme: 'dark' | 'light'): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.THEME_SET,
      theme,
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
    logHead: number,
    lastTimestamp?: number,
    substate?: StreamSubstate,
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS,
      stream,
      status,
      logHead,
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

  setActiveStream(activeStream: PresentedStreamId): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream,
    });
  }

  settleStreamSelection(
    requestId: string,
    status: 'accepted' | 'rejected' | 'superseded',
    activeStream: PresentedStreamId,
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.SETTLE_STREAM_SELECTION,
      requestId,
      status,
      activeStream,
    });
  }

  releaseStreamContent(stream: StreamTabId): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.RELEASE_STREAM_CONTENT,
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
   * Use this for structural updates (initial sync, stream add/remove).
   * For incremental updates, prefer targeted messages like:
   * setActiveStream(), updateConversationProgress(), updateStreamBadges(),
   * updateStreamStatus().
   */
  sendStreamMetadata(
    projection: ProjectedStreamRoster,
    activeStream: PresentedStreamId,
    theme?: 'dark' | 'light',
  ): void {
    if (!this.isAvailable()) {
      return;
    }

    if (theme) this.setTheme(theme);

    // Full stream-tabs refresh, carrying the per-stream metadata patch.
    const unsupportedCommands = this.getUnsupportedCommands?.();
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
      streams: projection.streams,
      activeStream,
      unsupportedCommands: unsupportedCommands
        ? [...unsupportedCommands]
        : undefined,
      streamStates: projection.streamStates,
    });
  }

  isAvailable(): boolean {
    return this.hasTarget();
  }
}
