import type { StreamPhaseState } from '@agent/runtime/StreamStatusService';
import { WebviewBridge } from '@controllers/progressView/backend/WebviewBridge';
import type { GetProgressStreamControls } from '@controllers/progressView/progressStreamControls';
import {
  buildStreamInfo,
  buildStreamInfos,
} from '@controllers/session/streamInfoUtils';
import type {
  PresentedStreamId,
  SessionRendererPort,
  SessionRenderSlice,
} from '@controllers/session/SessionRendererPort';
import type { SessionState } from '@controllers/session/SessionState';
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
  RoundIndexed,
  StreamContentRenderPayload,
  StreamMetadata,
  StreamPhase,
  StreamStage,
  StreamSubstate,
  StreamTabId,
  StreamTabInfo,
  TodoItem,
  TokenUsageStats,
} from '@shared/schemas';
import { buildStreamContentRender } from '@shared/streams/streamContentSync';
import { buildStreamMetadata } from '@shared/streams/streamMetadata';
import {
  assertNever,
  createFlushableDebounce,
  mapToRecord,
  type FlushableDebounce,
} from '@utils/core';

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
    private readonly state: SessionState,
    private readonly getStreamControls: GetProgressStreamControls,
    private readonly webviewBridge: WebviewBridge,
    private readonly send: (message: ProgressViewOutboundMessage) => void,
    private readonly hasTarget: () => boolean,
    private readonly getActiveStream: () => PresentedStreamId,
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
    this.updateStreamMetadata(streamId, options?.streamStates, options);
  }

  onStreamStatusChanged(
    streamId: StreamTabId,
    status: StreamPhase,
    logHead: number,
    lastTimestamp?: number,
    substate?: StreamSubstate,
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS,
      stream: streamId,
      status,
      logHead,
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

  onStreamDescriptionChanged(streamId: StreamTabId): void {
    this.updateStreamMetadata(streamId);
  }

  invalidate(streamId: StreamTabId, slice: SessionRenderSlice): void {
    switch (slice) {
      case 'files':
        return this.sendIfActive(streamId, () =>
          this.sendMessage({
            command: PROGRESS_VIEW_COMMANDS.UPDATE_FILES,
            stream: streamId,
            rounds: nonEmptyRounds(
              this.state.snapshots.getOutputFiles(streamId),
            ),
          }),
        );
      case 'compileFailures':
        return this.sendIfActive(streamId, () =>
          this.sendMessage({
            command: PROGRESS_VIEW_COMMANDS.UPDATE_COMPILE_FAILURES,
            stream: streamId,
            rounds: nonEmptyRounds(
              this.state.snapshots.getCompileFailures(streamId),
            ),
            reset: true,
          }),
        );
      case 'queuedFollowUps':
        return this.sendIfActive(streamId, () =>
          this.sendMessage({
            command: PROGRESS_VIEW_COMMANDS.UPDATE_QUEUED_FOLLOW_UPS,
            stream: streamId,
            messages: this.state.followUps.getAll(streamId),
          }),
        );
      case 'parentStreamId':
        // Parent edge rides `StreamTabInfo.parentStreamId` on the metadata wire.
        if (!this.isAvailable()) return;
        return this.updateStreamMetadata(streamId);
      case 'contextState':
        // Lit's usage footer restores the same snapshot from the transcript
        // rail's `contextState` log entry (`logSlice`), which — unlike this
        // session-scoped record — also repopulates a stream reopened from
        // disk. Nothing to push here.
        return;
      case 'goalPaused':
        // Lit surfaces pause via the goal chip (`goalStateChanged`); no
        // transcript notice, unlike the TUI.
        return;
    }
    assertNever(slice, 'Unhandled session render slice');
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
      this.updateStreamMetadata(streamId);
      return;
    }
    this.sendIfActive(streamId, () => this.updateStreamMetadata(streamId));
  }

  onBadgesChanged(streamId: StreamTabId): void {
    this.updateStreamMetadata(streamId);
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
      this.sendMessage({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS,
        stream: streamId,
        rounds: nonEmptyRounds(
          this.state.snapshots.getMissingOutputs(streamId),
        ),
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

    const projection = this.buildStreamContent(stream, includeActiveState);
    if (projection) {
      this.sendMessage({
        command: PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
        ...projection,
      });
    }
  }

  /**
   * Assemble the full SYNC_STREAM_CONTENT render snapshot from `SessionState`.
   * The payload shape itself is declared once in `buildStreamContentRender`
   * (shared with trace replay); the category-specific sections are lazy
   * getters so a workflow render never touches tool-use sources and vice
   * versa. `undefined` while a stream's run identity is still pending.
   */
  private buildStreamContent(
    stream: StreamTabId,
    includeActiveState: boolean,
  ): StreamContentRenderPayload | undefined {
    const { state, getStreamControls } = this;
    const existingState = state.getStreamState(stream);
    const category =
      state.getStreamMetadata(stream).agentCategory ?? existingState?.category;
    if (category === undefined) return undefined;

    const executionState = includeActiveState
      ? state.getOrCreateStreamState(stream, category)
      : undefined;
    return buildStreamContentRender(stream, category, {
      runUsage: mapToRecord(state.snapshots.getRunUsage(stream)),
      activeState: executionState && {
        conversationProgress: executionState.conversationProgress,
        stage: executionState.stage ?? null,
        badges: { subagents: executionState.subagents },
      },
      get outputs() {
        return {
          files: state.snapshots.getOutputFiles(stream),
          missing: state.snapshots.getMissingOutputs(stream),
          compileFailures: state.snapshots.getCompileFailures(stream),
        };
      },
      get workPlan() {
        const { todos, plan } = state.snapshots.getWorkPlan(stream);
        return {
          todos,
          plan,
          queuedFollowUps: state.followUps.getAll(stream),
        };
      },
      get controls() {
        const controls = getStreamControls(stream);
        return {
          bashBypass: controls.bashBypass,
          toolEditBypass: controls.toolEditBypass,
          superYoloBypass: controls.superYoloBypass,
          goal: controls.goalActive
            ? {
                active: true as const,
                status: controls.goalStatus,
                objective: controls.goalObjective,
              }
            : { active: false as const },
        };
      },
    });
  }

  /** Push one stream's metadata patch, optionally re-asserting the selection. */
  updateStreamMetadata(
    streamId: StreamTabId,
    streamStates?: Map<StreamTabId, StreamPhaseState>,
    options?: { activeStream?: PresentedStreamId },
  ): void {
    if (!this.isAvailable()) return;
    const streamInfo = buildStreamInfo(
      this.state,
      streamId,
      options?.activeStream ?? this.getActiveStream(),
    );
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
      streamInfo,
      streamState: this.metadataFor(
        streamInfo,
        streamStates ?? this.state.streamStatus.getAllStreamStates(),
      ),
      activeStream: options?.activeStream,
    });
  }

  /**
   * Update stream metadata and theme for the webview.
   * Use this for structural updates (initial sync, stream add/remove).
   * For incremental updates, prefer the targeted notifications above.
   * `projectedStream` selects which tab gets active-tab enrichment (worktree
   * probe) while `activeStream` is the selection the frontend is told about.
   */
  sendStreamMetadata(
    projectedStream: PresentedStreamId,
    activeStream: PresentedStreamId,
    theme?: 'dark' | 'light',
  ): void {
    if (!this.isAvailable()) return;

    if (theme) this.setTheme(theme);

    const streams = buildStreamInfos(this.state, projectedStream);
    const states = this.state.streamStatus.getAllStreamStates();
    const streamStates: Record<StreamTabId, StreamMetadata> = {};
    for (const streamInfo of streams) {
      streamStates[streamInfo.name] = this.metadataFor(streamInfo, states);
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
      streamStates,
    });
  }

  /** Immutable per-stream metadata for one already-built tab info. */
  private metadataFor(
    streamInfo: StreamTabInfo,
    streamStates: Map<StreamTabId, StreamPhaseState>,
  ): StreamMetadata {
    const current = this.state.getStreamState(streamInfo.name);
    const status = streamStates.get(streamInfo.name);
    return buildStreamMetadata({
      category: streamInfo.agentCategory,
      status: status?.phase,
      substate: status?.substate,
      userFollowUpSupport: streamInfo.userFollowUpSupport,
      lastTimestamp: this.state.streamLogs.getTimestampRange(streamInfo.name)
        .last,
      conversationProgress: current?.conversationProgress,
      stage: current?.stage,
      subagents: current?.subagents,
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

/** Omit empty round records so the frontend keeps its "no data" placeholder. */
function nonEmptyRounds<T>(
  rounds: RoundIndexed<T>,
): RoundIndexed<T> | undefined {
  return Object.keys(rounds).length ? rounds : undefined;
}
