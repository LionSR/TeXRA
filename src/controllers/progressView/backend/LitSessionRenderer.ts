import type { StreamPhaseState } from '@agent/runtime/StreamStatusService';
import type { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { WebviewBridge } from '@controllers/progressView/backend/WebviewBridge';
import {
  ProgressStreamProjectionBuilder,
  type ProjectedStreamRoster,
} from '@controllers/progressView/backend/ProgressStreamProjectionBuilder';
import type {
  PresentedStreamId,
  SessionRendererPort,
} from '@controllers/session/SessionRendererPort';
import type { StreamBadgeSnapshot } from '@controllers/session/SessionState';
import type { ApprovalBypassKind } from '@shared/approvalBypassKind';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  ConversationProgress,
  GoalStatus,
  InquiryThreadUpdatedEvent,
  PermissionPayload,
  Plan,
  ProgressPermissionKind,
  ProgressViewOutboundMessage,
  ProgressViewPlacement,
  StreamPhase,
  StreamStage,
  StreamSubstate,
  StreamTabId,
  TodoItem,
  TokenUsageStats,
} from '@shared/schemas';
import type { StreamSnapshotStore } from '@transcript/StreamSnapshotStore';
import { createFlushableDebounce, type FlushableDebounce } from '@utils/core';

/** Throttle interval for conversation progress webview pushes (ms). */
const PROGRESS_THROTTLE_MS = 500;

/**
 * The single owner of Lit/progress-view delivery: it both decides *what* the
 * webview is told (active-only delivery, conversation-progress debounce,
 * phase-vs-round stage delivery, bridge cursor synchronization) and builds the
 * typed outbound messages that carry it.
 */
export class LitSessionRenderer implements SessionRendererPort {
  private readonly progressDebounce: FlushableDebounce =
    createFlushableDebounce(
      () => this.flushProgressUpdates(),
      PROGRESS_THROTTLE_MS,
    );
  private readonly pendingProgressUpdates = new Map<
    StreamTabId,
    ConversationProgress
  >();

  constructor(
    private readonly projections: ProgressStreamProjectionBuilder,
    private readonly snapshots: StreamSnapshotStore,
    private readonly followUps: ToolUseFollowUpQueue,
    private readonly webviewBridge: WebviewBridge,
    private readonly send: (message: ProgressViewOutboundMessage) => void,
    private readonly hasTarget: () => boolean,
    private readonly getActiveStream: () => PresentedStreamId = () => '',
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
   * Deliver one typed message to the current active webview target. Uses the
   * `ProgressViewOutboundMessage` union for compile-time safety.
   */
  private sendMessage(message: ProgressViewOutboundMessage): void {
    if (!this.hasTarget()) return;
    this.send(message);
  }

  isAvailable(): boolean {
    return this.hasTarget();
  }

  dispose(): void {
    this.progressDebounce.cancel();
    this.pendingProgressUpdates.clear();
    this.webviewBridge.clearAll();
  }

  clearPendingConversationProgress(streamId: StreamTabId): void {
    this.pendingProgressUpdates.delete(streamId);
  }

  onStreamMetadataChanged(
    streamId: StreamTabId,
    options?: {
      streamStates?: Map<StreamTabId, StreamPhaseState>;
      activeStream?: PresentedStreamId;
    },
  ): void {
    if (!this.isAvailable()) return;
    this.updateStreamMetadata(streamId, options?.streamStates, {
      activeStream: options?.activeStream,
    });
  }

  onStreamStatusChanged(
    streamId: StreamTabId,
    status: StreamPhase,
    lastTimestamp?: number,
    substate?: StreamSubstate,
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS,
      stream: streamId,
      status,
      lastTimestamp,
      ...(substate ? { substate } : {}),
    });
  }

  onActiveStreamChanged(streamId: PresentedStreamId): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: streamId,
    });
  }

  onStreamDescriptionChanged(streamId: StreamTabId, description: string): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_DESCRIPTION,
      stream: streamId,
      description,
    });
  }

  onParentStreamChanged(
    childStreamId: StreamTabId,
    _parentStreamId: StreamTabId | null,
  ): void {
    // Parent edge rides `StreamTabInfo.parentStreamId` on the metadata wire.
    if (!this.isAvailable()) return;
    this.updateStreamMetadata(childStreamId);
  }

  onConversationProgressChanged(
    streamId: StreamTabId,
    progress: ConversationProgress,
  ): void {
    // Throttle webview pushes: buffer per-stream, flush on timer. State is
    // already updated by SessionFactApplier before this notify.
    this.pendingProgressUpdates.set(streamId, progress);
    if (!this.progressDebounce.pending) this.progressDebounce.schedule();
  }

  onStageChanged(streamId: StreamTabId, stage: StreamStage): void {
    if (stage.kind === 'phase') {
      // A workflow-script run's phase is read from its *parent's* viewport
      // (the Background Tasks row for that run), so unlike round progress it
      // cannot be pushed only for the active stream. It rides the existing
      // per-stream metadata patch instead of the targeted message: phases
      // advance a handful of times per run, so the extra fields on the wire
      // cost nothing.
      if (!this.isAvailable()) return;
      this.updateStreamMetadata(streamId);
      return;
    }
    this.sendIfActive(streamId, () =>
      this.sendMessage({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_STAGE,
        stream: streamId,
        stage,
      }),
    );
  }

  onBadgesChanged(streamId: StreamTabId, badges: StreamBadgeSnapshot): void {
    // Badges are the child roster (`StreamBadgeSnapshot` = `subagents`), read
    // from the parent's viewport in Background Tasks — so, like a phase and
    // unlike round progress, they cannot be pushed only for the active
    // stream. Gating them dropped the roster update that retires a finished
    // child, leaving its row live ("Running") until the parent happened to be
    // reactivated. The message is stream-addressed and stored per stream, and
    // a child's lifecycle emits a handful of them, so sending always is cheap.
    if (!this.isAvailable()) return;
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_BADGES,
      stream: streamId,
      ...badges,
    });
  }

  onFilesChanged(streamId: StreamTabId): void {
    this.sendIfActive(streamId, () => {
      const rounds = this.snapshots.getOutputFiles(streamId);
      this.sendMessage({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_FILES,
        stream: streamId,
        rounds: Object.keys(rounds).length ? rounds : undefined,
      });
    });
  }

  onMissingOutputsChanged(
    streamId: StreamTabId,
    options?: { reset?: boolean },
  ): void {
    this.sendIfActive(streamId, () => {
      if (options?.reset) {
        this.sendMessage({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS,
          stream: streamId,
          reset: true,
        });
        return;
      }
      const rounds = this.snapshots.getMissingOutputs(streamId);
      this.sendMessage({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS,
        stream: streamId,
        rounds: Object.keys(rounds).length ? rounds : undefined,
      });
    });
  }

  onCompileFailuresChanged(streamId: StreamTabId): void {
    this.sendIfActive(streamId, () => {
      const rounds = this.snapshots.getCompileFailures(streamId);
      this.sendMessage({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_COMPILE_FAILURES,
        stream: streamId,
        rounds: Object.keys(rounds).length ? rounds : undefined,
        reset: true,
      });
    });
  }

  onRunUsageChanged(
    streamId: StreamTabId,
    storageKey: string,
    usage: TokenUsageStats,
  ): void {
    // Prefer the snapshot store's normalized per-key value when present (fills
    // cache/reasoning zeros); fall back to the event payload.
    const nextUsage =
      this.snapshots.getRunUsage(streamId).get(storageKey) ?? usage;
    this.sendIfActive(streamId, () =>
      this.sendMessage({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE,
        stream: streamId,
        runId: storageKey,
        usage: nextUsage,
      }),
    );
  }

  onTodosChanged(streamId: StreamTabId, todos: TodoItem[]): void {
    this.sendIfActive(streamId, () =>
      this.sendMessage({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_TODOS,
        stream: streamId,
        todos,
      }),
    );
  }

  onPlanChanged(streamId: StreamTabId, plan: Plan | null): void {
    // Plan is not active-gated (historical Lit delivery quirk).
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_PLAN,
      stream: streamId,
      plan,
    });
  }

  onQueuedFollowUpsChanged(streamId: StreamTabId): void {
    this.sendIfActive(streamId, () => {
      this.sendMessage({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_QUEUED_FOLLOW_UPS,
        stream: streamId,
        messages: this.followUps.getAll(streamId),
      });
    });
  }

  onInquiryThreadUpdated(thread: InquiryThreadUpdatedEvent): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_INQUIRY_THREAD,
      thread,
    });
  }

  onGoalActiveChanged(
    streamId: StreamTabId,
    active: boolean,
    details?: { status?: GoalStatus; objective?: string },
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.GOAL_ACTIVE_UPDATED,
      stream: streamId,
      active,
      ...(details?.status ? { status: details.status } : {}),
      ...(details?.objective ? { objective: details.objective } : {}),
    });
  }

  onGoalPaused(_streamId: StreamTabId): void {
    // Lit surfaces pause via the goal chip (`goalStateChanged`); no transcript.
  }

  syncStreamContent(
    stream: PresentedStreamId,
    options: {
      includeActiveState?: boolean;
    } = {},
  ): void {
    if (!this.isAvailable()) return;

    const { includeActiveState = false } = options;

    if (!stream) {
      this.sendMessage({
        command: PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
        action: 'clear',
      });
      return;
    }

    this.webviewBridge.syncStream(stream);

    const projection = this.projections.streamContent(
      stream,
      includeActiveState,
    );
    if (projection) {
      this.sendMessage({
        command: PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
        ...projection,
      });
    }
  }

  /** Push one stream's metadata patch, optionally re-asserting the selection. */
  updateStreamMetadata(
    streamId: StreamTabId,
    streamStates?: Map<StreamTabId, StreamPhaseState>,
    options?: { activeStream?: PresentedStreamId },
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
      ...this.projections.streamMetadata(
        streamId,
        streamStates,
        options?.activeStream ?? this.getActiveStream(),
      ),
      activeStream: options?.activeStream,
    });
  }

  /**
   * Update stream metadata and theme for the webview.
   * Use this for structural updates (initial sync, stream add/remove).
   * For incremental updates, prefer the targeted notifications above.
   */
  sendStreamMetadata(
    projection: ProjectedStreamRoster,
    activeStream: PresentedStreamId,
    theme?: 'dark' | 'light',
  ): void {
    if (!this.isAvailable()) return;

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

  syncInquiryThreads(threads: InquiryThreadUpdatedEvent[]): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.SYNC_INQUIRY_THREADS,
      threads,
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

  /** Send to webview only if streamId is the active stream. */
  private sendIfActive(streamId: string, send: () => void): void {
    if (streamId === this.getActiveStream() && this.isAvailable()) {
      send();
    }
  }

  private flushProgressUpdates(): void {
    const activeStream = this.getActiveStream();
    const progress = activeStream
      ? this.pendingProgressUpdates.get(activeStream)
      : undefined;
    if (progress && this.isAvailable()) {
      this.sendMessage({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_CONVERSATION_PROGRESS,
        stream: activeStream,
        progress,
      });
    }
    this.pendingProgressUpdates.clear();
  }
}
