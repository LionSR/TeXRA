import type { StreamPhaseState } from '@agent/runtime/StreamStatusService';
import type { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { WebviewBridge } from '@controllers/progressView/backend/WebviewBridge';
import { ProgressStreamProjectionBuilder } from '@controllers/progressView/backend/ProgressStreamProjectionBuilder';
import { WebviewUpdater } from '@controllers/progressView/backend/WebviewUpdater';
import type {
  PresentedStreamId,
  SessionRendererPort,
} from '@controllers/session/SessionRendererPort';
import type { StreamBadgeSnapshot } from '@controllers/session/SessionState';
import type {
  ConversationProgress,
  GoalStatus,
  InquiryThreadUpdatedEvent,
  Plan,
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
 * Lit/progress-view delivery policy over immutable stream projections.
 * Owns active-only delivery, conversation-progress debounce, phase-vs-round
 * stage delivery, and bridge cursor synchronization.
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
    private readonly webviewUpdater: WebviewUpdater,
    private readonly webviewBridge: WebviewBridge,
    private readonly getActiveStream: () => PresentedStreamId = () => '',
  ) {}

  isAvailable(): boolean {
    return this.webviewUpdater.isAvailable();
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
    if (!this.webviewUpdater.isAvailable()) return;
    this.webviewUpdater.updateStreamMetadata(
      this.projections.streamMetadata(
        streamId,
        options?.streamStates,
        options?.activeStream ?? this.getActiveStream(),
      ),
      { activeStream: options?.activeStream },
    );
  }

  onStreamStatusChanged(
    streamId: StreamTabId,
    status: StreamPhase,
    logHead: number,
    lastTimestamp?: number,
    substate?: StreamSubstate,
  ): void {
    this.webviewUpdater.updateStreamStatus(
      streamId,
      status,
      logHead,
      lastTimestamp,
      substate,
    );
  }

  onActiveStreamChanged(streamId: PresentedStreamId): void {
    this.webviewUpdater.setActiveStream(streamId);
  }

  onStreamDescriptionChanged(streamId: StreamTabId, description: string): void {
    this.webviewUpdater.updateStreamDescription(streamId, description);
  }

  onParentStreamChanged(
    childStreamId: StreamTabId,
    _parentStreamId: StreamTabId | null,
  ): void {
    // Parent edge rides `StreamTabInfo.parentStreamId` on the metadata wire.
    if (!this.webviewUpdater.isAvailable()) return;
    this.webviewUpdater.updateStreamMetadata(
      this.projections.streamMetadata(
        childStreamId,
        undefined,
        this.getActiveStream(),
      ),
    );
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
      if (!this.webviewUpdater.isAvailable()) return;
      this.webviewUpdater.updateStreamMetadata(
        this.projections.streamMetadata(
          streamId,
          undefined,
          this.getActiveStream(),
        ),
      );
      return;
    }
    this.sendIfActive(streamId, () =>
      this.webviewUpdater.updateStage(streamId, stage),
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
    if (!this.webviewUpdater.isAvailable()) return;
    this.webviewUpdater.updateStreamBadges(streamId, badges);
  }

  onFilesChanged(streamId: StreamTabId): void {
    this.sendIfActive(streamId, () => {
      const rounds = this.snapshots.getOutputFiles(streamId);
      this.webviewUpdater.updateFiles(streamId, {
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
        this.webviewUpdater.updateMissingOutputs(streamId, { reset: true });
        return;
      }
      const rounds = this.snapshots.getMissingOutputs(streamId);
      this.webviewUpdater.updateMissingOutputs(streamId, {
        rounds: Object.keys(rounds).length ? rounds : undefined,
      });
    });
  }

  onCompileFailuresChanged(streamId: StreamTabId): void {
    this.sendIfActive(streamId, () => {
      const rounds = this.snapshots.getCompileFailures(streamId);
      this.webviewUpdater.updateCompileFailures(streamId, {
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
      this.webviewUpdater.updateRunUsage(streamId, storageKey, nextUsage),
    );
  }

  onTodosChanged(streamId: StreamTabId, todos: TodoItem[]): void {
    this.sendIfActive(streamId, () =>
      this.webviewUpdater.updateTodos(streamId, todos),
    );
  }

  onPlanChanged(streamId: StreamTabId, plan: Plan | null): void {
    // Plan is not active-gated (historical Lit delivery quirk).
    this.webviewUpdater.updatePlan(streamId, plan);
  }

  onQueuedFollowUpsChanged(streamId: StreamTabId): void {
    this.sendIfActive(streamId, () => {
      const messages = this.followUps.getAll(streamId);
      this.webviewUpdater.updateQueuedFollowUps(streamId, messages);
    });
  }

  onInquiryThreadUpdated(thread: InquiryThreadUpdatedEvent): void {
    this.webviewUpdater.updateInquiryThread(thread);
  }

  onGoalActiveChanged(
    streamId: StreamTabId,
    active: boolean,
    details?: { status?: GoalStatus; objective?: string },
  ): void {
    this.webviewUpdater.updateGoalActive(streamId, active, details);
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
    if (!this.webviewUpdater.isAvailable()) return;

    const { includeActiveState = false } = options;

    if (!stream) {
      this.webviewUpdater.sendSyncStreamContent({ action: 'clear' });
      return;
    }

    this.webviewBridge.syncStream(stream);

    const projection = this.projections.streamContent(
      stream,
      includeActiveState,
    );
    if (projection) this.webviewUpdater.sendSyncStreamContent(projection);
  }

  /** Send to webview only if streamId is the active stream. */
  private sendIfActive(streamId: string, send: () => void): void {
    if (
      streamId === this.getActiveStream() &&
      this.webviewUpdater.isAvailable()
    ) {
      send();
    }
  }

  private flushProgressUpdates(): void {
    const activeStream = this.getActiveStream();
    const progress = activeStream
      ? this.pendingProgressUpdates.get(activeStream)
      : undefined;
    if (progress && this.webviewUpdater.isAvailable()) {
      this.webviewUpdater.updateConversationProgress(activeStream, progress);
    }
    this.pendingProgressUpdates.clear();
  }
}
