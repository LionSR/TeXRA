import { SubscriptionRef } from 'effect';

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
import { cloneRoundIndexed } from '@shared/schemas';
import type {
  ConversationProgress,
  GoalStatus,
  InquiryThreadUpdatedEvent,
  PermissionPayload,
  Plan,
  ProgressPermissionKind,
  ProgressViewOutboundMessage,
  ProgressViewPlacement,
  ReadonlyRoundIndexed,
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
import { STREAM_LIFECYCLE_UNAVAILABLE, STREAM_STATUS } from '@shared/schemas';
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
  /**
   * The streams this renderer has actually put on screen — the roster of the
   * last `UPDATE_STREAMS`, plus every stream an incremental
   * `UPDATE_STREAM_METADATA` introduced since. Nothing else remembers it:
   * both messages are built from live state and keep no copy, and live state
   * stops listing a stream the moment it is deleted, including when some
   * other owner deleted it. That is exactly when a row is stranded (the
   * leftover sweep republishes each swept shell as a `removeStream` fact for
   * that reason), so this is what answers "is the view still showing this
   * stream?" once its durable state is already gone.
   */
  private readonly renderedStreams = new Set<StreamTabId>();

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
    this.renderedStreams.clear();
    this.webviewBridge.clearAll();
  }

  /** Whether this renderer's last projection put `stream` on screen. */
  hasRenderedStream(stream: StreamTabId): boolean {
    return this.renderedStreams.has(stream);
  }

  /** Forget a stream whose removal this renderer has just projected. */
  forgetRenderedStream(stream: StreamTabId): void {
    this.renderedStreams.delete(stream);
  }

  clearPendingConversationProgress(streamId: StreamTabId): void {
    this.pendingProgressUpdates.delete(streamId);
  }

  onStreamMetadataChanged(
    streamId: StreamTabId,
    options?: {
      phaseOverride?: StreamPhaseState;
    },
  ): void {
    if (!this.isAvailable()) return;
    this.updateStreamMetadata(streamId, options?.phaseOverride);
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
            // Replace, don't merge: the store deletes a round whose output-file
            // list goes empty (ROUND_FIELD_NORMALIZERS), and the read above
            // already includes the fact that triggered this invalidation, since
            // the store subscribes to session events in SessionHandle's
            // constructor, before any host applier.
            reset: true,
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
      case 'missingOutputs':
        return this.sendIfActive(streamId, () => {
          this.sendMessage({
            command: PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS,
            stream: streamId,
            rounds: nonEmptyRounds(
              this.state.snapshots.getMissingOutputs(streamId),
            ),
          });
        });
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
      case 'subagents':
        return this.updateStreamMetadata(streamId);
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

  syncStreamContent(stream: PresentedStreamId): void {
    if (!this.isAvailable()) return;

    if (!stream) {
      this.sendMessage({
        command: PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
        action: 'clear',
      });
      return;
    }

    this.webviewBridge.syncStream(stream);

    const projection = this.buildStreamContent(stream);
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
  ): StreamContentRenderPayload | undefined {
    const { state, getStreamControls } = this;
    const existingState = state.getStreamState(stream);
    const category =
      state.getStreamMetadata(stream).agentCategory ?? existingState?.category;
    if (category === undefined) return undefined;

    // `getOrCreateStreamState` materializes the row; `getStreamState` is the
    // read that filters removed children out of `subagents`, so both calls stay.
    state.getOrCreateStreamState(stream, category);
    const executionState = state.getStreamState(stream);
    return buildStreamContentRender(stream, category, {
      runUsage: mapToRecord(state.snapshots.getRunUsage(stream)),
      activeState: executionState && {
        conversationProgress: executionState.conversationProgress,
        stage: executionState.stage ?? null,
        badges: { subagents: executionState.subagents },
      },
      // Wire boundary: this payload is serialized to the webview, so it takes
      // a snapshot. Lazy via the getter, so a payload that never reads outputs
      // never pays for one.
      get outputs() {
        return {
          files: cloneRoundIndexed(state.snapshots.getOutputFiles(stream)),
          missing: cloneRoundIndexed(state.snapshots.getMissingOutputs(stream)),
          compileFailures: cloneRoundIndexed(
            state.snapshots.getCompileFailures(stream),
          ),
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
        return getStreamControls(stream);
      },
    });
  }

  /** Push one stream's metadata patch. */
  updateStreamMetadata(
    streamId: StreamTabId,
    phaseOverride?: StreamPhaseState,
  ): void {
    if (!this.isAvailable()) return;
    const streamInfo = buildStreamInfo(
      this.state,
      streamId,
      this.getActiveStream(),
    );
    this.renderedStreams.add(streamId);
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
      streamInfo,
      streamState: this.metadataFor(streamInfo, phaseOverride),
    });
  }

  /**
   * Update stream metadata for the webview.
   * Use this for structural updates (initial sync, stream add/remove).
   * For incremental updates, prefer the targeted notifications above.
   * `projectedStream` selects which tab gets active-tab enrichment (worktree
   * probe) while `activeStream` is the selection the frontend is told about.
   */
  sendStreamMetadata(
    projectedStream: PresentedStreamId,
    activeStream: PresentedStreamId,
  ): void {
    if (!this.isAvailable()) return;

    const streams = buildStreamInfos(this.state, projectedStream);
    const streamStates: Record<StreamTabId, StreamMetadata> = {};
    for (const streamInfo of streams) {
      streamStates[streamInfo.name] = this.metadataFor(streamInfo);
    }

    // A full refresh replaces the roster wholesale, incremental additions
    // included: what is not in this message is not on screen any more.
    this.renderedStreams.clear();
    for (const streamInfo of streams) this.renderedStreams.add(streamInfo.name);

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

  /**
   * Immutable per-stream metadata for one already-built tab info.
   *
   * `phaseOverride` is the one phase the view cannot see yet: the status a
   * caller is in the middle of applying, which has not reached the fold.
   * Everything else comes from the stream's `SessionView` arm.
   */
  private metadataFor(
    streamInfo: StreamTabInfo,
    phaseOverride?: StreamPhaseState,
  ): StreamMetadata {
    const current = this.state.getStreamState(streamInfo.name);
    const view = SubscriptionRef.getUnsafe(this.state.view).streams.get(
      streamInfo.name,
    );
    const status: StreamPhaseState | undefined =
      phaseOverride ??
      (view && view.status !== STREAM_STATUS.READY
        ? {
            phase: view.status,
            ...(view.substate ? { substate: view.substate } : {}),
            ...(view.runStartedAt !== null
              ? { runStartedAt: view.runStartedAt }
              : {}),
          }
        : undefined);
    // A stream this process cannot act on (held elsewhere, unreadable) has
    // no phase here; the wire carries the sentinel so the view renders it
    // read-only, with `statusDetail` saying why.
    const statusDetail =
      phaseOverride || !view?.readOnly
        ? undefined
        : (view.statusDetail ?? undefined);
    return buildStreamMetadata({
      category: streamInfo.agentCategory,
      status: statusDetail ? STREAM_LIFECYCLE_UNAVAILABLE : status?.phase,
      // A phase this caller is still applying is not final by definition.
      statusDurablyFinal:
        phaseOverride === undefined && view?.durableOutcome != null,
      statusDetail,
      // The unavailable sentinel travels alone: a hold keeps the phase the
      // stream had, and shipping that phase's substate with the sentinel
      // would light the active-run controls on a run this process cannot act
      // on.
      substate: statusDetail ? undefined : status?.substate,
      runStartedAt: status?.runStartedAt,
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
// The wire boundary: an outbound message is a snapshot by nature, so this is
// where the copy belongs — once per message, rather than on every store read.
function nonEmptyRounds<T>(
  rounds: ReadonlyRoundIndexed<T>,
): RoundIndexed<T> | undefined {
  return Object.keys(rounds).length ? cloneRoundIndexed(rounds) : undefined;
}
