import type { StreamPhaseState } from '@agent/runtime/StreamStatusService';
import { WebviewBridge } from '@controllers/progressView/backend/WebviewBridge';
import { WebviewUpdater } from '@controllers/progressView/backend/WebviewUpdater';
import type { SessionRendererPort } from '@controllers/session/SessionRendererPort';
import {
  SessionState,
  type ActiveStreamId,
  type StreamBadgeSnapshot,
} from '@controllers/session/SessionState';
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
import { AgentCategory } from '@shared/schemas';
import {
  createFlushableDebounce,
  mapToRecord,
  type FlushableDebounce,
} from '@utils/core';

/** Throttle interval for conversation progress webview pushes (ms). */
const PROGRESS_THROTTLE_MS = 500;

interface ProgressStreamBypassControls {
  bashBypass: boolean;
  toolEditBypass: boolean;
  superYoloBypass: boolean;
}

export type ProgressStreamControls = ProgressStreamBypassControls &
  (
    | { goalActive: false }
    | { goalActive: true; goalStatus: GoalStatus; goalObjective: string }
  );

export type GetProgressStreamControls = (
  stream: StreamTabId,
) => ProgressStreamControls;

function getDefaultProgressStreamControls(): ProgressStreamControls {
  return {
    bashBypass: false,
    toolEditBypass: false,
    superYoloBypass: false,
    goalActive: false,
  };
}

/**
 * Lit/progress-view renderer over {@link SessionState}: owns postMessage push
 * policy (`sendIfActive`, conversation-progress debounce, phase-vs-round stage
 * delivery, bridge cursor sync, controls packing).
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
    private readonly state: SessionState,
    private readonly webviewUpdater: WebviewUpdater,
    private readonly webviewBridge: WebviewBridge,
    private readonly getStreamControls: GetProgressStreamControls = getDefaultProgressStreamControls,
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
      activeStream?: ActiveStreamId;
    },
  ): void {
    if (!this.webviewUpdater.isAvailable()) return;
    this.webviewUpdater.updateStreamMetadata(
      this.state,
      streamId,
      options?.streamStates,
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

  onActiveStreamChanged(streamId: ActiveStreamId): void {
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
      this.state,
      childStreamId,
      this.state.streamStatus.getAllStreamStates(),
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
        this.state,
        streamId,
        this.state.streamStatus.getAllStreamStates(),
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
      const rounds = this.state.snapshots.getOutputFiles(streamId);
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
      const rounds = this.state.snapshots.getMissingOutputs(streamId);
      this.webviewUpdater.updateMissingOutputs(streamId, {
        rounds: Object.keys(rounds).length ? rounds : undefined,
      });
    });
  }

  onCompileFailuresChanged(streamId: StreamTabId): void {
    this.sendIfActive(streamId, () => {
      const rounds = this.state.snapshots.getCompileFailures(streamId);
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
      this.state.snapshots.getRunUsage(streamId).get(storageKey) ?? usage;
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
      const messages = this.state.followUps.getAll(streamId);
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
    stream: ActiveStreamId,
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

    const existingState = this.state.getStreamState(stream);
    const category =
      this.state.getStreamMetadata(stream).agentCategory ??
      existingState?.category;
    // A stream whose category has not resolved yet has nothing to render —
    // it stays pending until run.config or the snapshot seed supplies one.
    if (category === undefined) return;

    const executionState = includeActiveState
      ? this.state.getOrCreateStreamState(stream, category)
      : undefined;
    const activeState = executionState
      ? {
          conversationProgress: executionState.conversationProgress,
          stage: executionState.stage ?? null,
          badges: { subagents: executionState.subagents },
        }
      : undefined;

    const shared = {
      action: 'render' as const,
      stream,
      runUsage: mapToRecord(this.state.snapshots.getRunUsage(stream)),
      ...(activeState ? { activeState } : {}),
    };

    if (category === AgentCategory.Workflow) {
      this.webviewUpdater.sendSyncStreamContent({
        ...shared,
        category,
        outputs: {
          files: this.state.snapshots.getOutputFiles(stream),
          missing: this.state.snapshots.getMissingOutputs(stream),
          compileFailures: this.state.snapshots.getCompileFailures(stream),
        },
      });
      return;
    }

    const { todos, plan } = this.state.snapshots.getWorkPlan(stream);
    const controls = this.getStreamControls(stream);
    this.webviewUpdater.sendSyncStreamContent({
      ...shared,
      category,
      workPlan: {
        todos,
        plan,
        queuedFollowUps: this.state.followUps.getAll(stream),
      },
      controls: {
        bashBypass: controls.bashBypass,
        toolEditBypass: controls.toolEditBypass,
        superYoloBypass: controls.superYoloBypass,
        goal: controls.goalActive
          ? {
              active: true,
              status: controls.goalStatus,
              objective: controls.goalObjective,
            }
          : { active: false },
      },
    });
  }

  /** Send to webview only if streamId is the active stream. */
  private sendIfActive(streamId: string, send: () => void): void {
    if (
      streamId === this.state.activeStream &&
      this.webviewUpdater.isAvailable()
    ) {
      send();
    }
  }

  private flushProgressUpdates(): void {
    const { activeStream } = this.state;
    const progress = activeStream
      ? this.pendingProgressUpdates.get(activeStream)
      : undefined;
    if (progress && this.webviewUpdater.isAvailable()) {
      this.webviewUpdater.updateConversationProgress(activeStream, progress);
    }
    this.pendingProgressUpdates.clear();
  }
}
