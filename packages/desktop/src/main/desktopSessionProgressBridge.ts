/**
 * Desktop session-progress bridge.
 *
 * Extracted from DesktopProgressBridge to own the ghost-stream hydration,
 * stream-snapshot persistence, restored-display sending, and desktop-local
 * presentation events. The parent bridge composes this as a focused
 * collaborator and keeps runtime-host, approval, resume, and stream-lifecycle
 * wiring.
 *
 * This is Slice 1 of the desktopAgentExecution.ts refactor (issue #6329).
 */

import { buildStreamInfo } from '@controllers/progressView/backend/streamInfoUtils';
import type { AgentEvent, AgentTrace } from '@agent/trace';
import type { SessionEvent, SessionFact } from '@agent/runtime/SessionEventHub';
import type { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  STREAM_PHASE,
  type ProgressViewOutboundMessage,
  type RequestEnsureProgressViewPayload,
  type RequestShowErrorPayload,
  type RequestShowInstructionPayload,
  type RestoredStreamSnapshot,
  type SetActiveStreamPayload,
  type StreamTabId,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas/agent';
import { isGoalInFlight, type GoalStatus } from '@shared/schemas/goal';
import { GoalStore } from '@tools/goal';
import { assertNever } from '@utils/core';
import { toLogData } from './desktopLogUtils.js';
import type { ProgressViewState } from '@controllers/progressView/backend/state/ProgressViewState';
import type { DesktopStreamSnapshotStore } from './desktopStreamSnapshot.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface DesktopSessionProgressBridgeOptions {
  /** The owning bridge's progress-view state. */
  state: ProgressViewState;
  /** Session-owned stream status plane for this desktop window. */
  streamStatus: Pick<StreamStatusMachine, 'get' | 'transition'>;
  /** Snapshot store for cross-launch persistence (may be undefined). */
  streamSnapshotStore?: DesktopStreamSnapshotStore;
  /** Sends a progress-view outbound message to the renderer. */
  sendMessage: (message: ProgressViewOutboundMessage) => void;
  /** Logger channel (scoped to the owning bridge). */
  logger: AgentTrace;
  /** Returns the current active stream id ('' if none). */
  getActiveStream: () => string;
  /** Routes the renderer to the progress view. */
  routeToProgress: () => void;
  /**
   * Called when a goal's state changes.  The parent bridge wires this to
   * `webviewUpdater.updateGoalActive`.
   */
  onGoalStateChanged: (
    streamId: StreamTabId,
    active: boolean,
    opts?: { status?: GoalStatus; objective?: string },
  ) => void;
  /**
   * Called when a `requestShowError` (or `requestShowInstruction`, folded
   * into the same dialog surface) event fires.
   */
  onShowError: (message: string) => void;
}

export interface DesktopPresentationPayloads {
  requestEnsureProgressView: RequestEnsureProgressViewPayload;
  requestShowError: RequestShowErrorPayload;
  requestShowInstruction: RequestShowInstructionPayload;
}

export type DesktopPresentationEvent = keyof DesktopPresentationPayloads;

// ── Public interface ────────────────────────────────────────────────────────

export interface DesktopSessionProgressBridge {
  /** All currently-hydrated ghost streams (keyed by streamId). */
  readonly restoredStreams: ReadonlyMap<StreamTabId, RestoredStreamSnapshot>;

  /**
   * Reapply restored stream placeholders, hints, and statuses from the snapshot
   * store. This is idempotent and may run again after durable state is loaded.
   */
  hydrateRestoredStreams(): void;

  /** Remove restored ghost ownership for executions already active in-process. */
  forgetActiveRestoredStreams(
    activeExecutionIds: ReadonlySet<string>,
    streamExecutionIds?: ReadonlyMap<StreamTabId, string>,
  ): void;

  /** True when a ghost stream with the given id exists. */
  hasRestoredStream(streamId: StreamTabId): boolean;

  /**
   * Handle a desktop presentation event emitted through the runtime host.
   *
   * Session and run facts reach this bridge through `handleSessionEvent`; this path
   * is only for window-local host requests that have no durable session fact.
   */
  handlePresentationEvent<K extends DesktopPresentationEvent>(
    event: K,
    payload: DesktopPresentationPayloads[K],
  ): void;

  /** Handle session/run facts emitted by this window's SessionEventHub. */
  handleSessionEvent(event: SessionEvent): void;

  /**
   * Restore a ghost stream's persisted sidecar display (todos, plan, usage,
   * output files) if it hasn't been restored yet.  Public so `syncStreamContent`
   * can call it after ensuring logs are loaded.
   */
  sendRestoredDisplay(streamId: StreamTabId): void;

  /**
   * Called when a single stream is deleted so ghost state can be cleaned up.
   */
  onStreamDeleted(streamId: StreamTabId): void;

  /**
   * Called when all streams are deleted.  Persists an empty snapshot list
   * and clears all in-memory ghost state.
   */
  onAllStreamsDeleted(): Promise<void>;

  /** Tear down local state and ignore any late runtime-host events. */
  dispose(): void;
}

// ── Implementation ──────────────────────────────────────────────────────────

class DesktopSessionProgressBridgeImpl implements DesktopSessionProgressBridge {
  readonly restoredStreams = new Map<StreamTabId, RestoredStreamSnapshot>();

  /** Ghost streams whose persisted display has already been restored this session. */
  private readonly restoredDisplaySent = new Set<StreamTabId>();
  /** Ghost streams with an async persisted-display restore already pending. */
  private readonly restoredDisplayInFlight = new Set<StreamTabId>();
  /** Streams that became live in this bridge and must not be restored as ghosts. */
  private readonly liveStreams = new Set<StreamTabId>();
  /** Fact values known before the durable snapshot meta view catches up. */
  private readonly liveSnapshotFacts = new Map<
    StreamTabId,
    Partial<Pick<RestoredStreamSnapshot, 'executionId' | 'lastKnownStatus'>>
  >();

  /** True once `dispose()` has torn down this bridge. */
  private disposed = false;

  constructor(private readonly opts: DesktopSessionProgressBridgeOptions) {
    // Hydrate previously-persisted "ghost" streams so the rail shows
    // the user's prior runs at launch (audit item D / trajectory #19).
    // We seed creation timestamps, statuses, descriptions, executionIds,
    // and categories from the snapshot — but NOT taskState, since we
    // can't resurrect runtime state. The renderer will show these as
    // stopped/orphaned entries; "Resume run" funnels back through the
    // existing storage-backed resume path when an executionId is
    // available, otherwise falls back to "start fresh".
    this.hydrateRestoredStreams();

    // Desktop presentation requests are window-owned: root/runtime-host events
    // reach this bridge through `DesktopProgressBridge.handleInteractionEvent` and
    // then `handlePresentationEvent` — never through any process-global channel,
    // which would make root UI actions cross window boundaries and outlive
    // the owning renderer.
  }

  // ── Query ───────────────────────────────────────────────────────────────

  hydrateRestoredStreams(): void {
    const hydrated = this.opts.streamSnapshotStore?.hydrated ?? [];
    this.restoredStreams.clear();
    for (const snapshot of hydrated) {
      if (this.liveStreams.has(snapshot.streamId)) continue;
      this.restoredStreams.set(snapshot.streamId, snapshot);
      this.opts.state.streamLogs.ensureStream(snapshot.streamId);
      this.opts.state.updateStreamMetadata(snapshot.streamId, {
        agent: snapshot.agent,
        agentCategory: snapshot.agentCategory,
        inputFile: snapshot.inputFile,
        creationTimestamp: snapshot.creationTimestamp,
        executionId: snapshot.executionId,
        parentStreamId: snapshot.parentStreamId,
        description: snapshot.description,
      });
      this.opts.streamStatus.transition(
        snapshot.streamId,
        snapshot.lastKnownStatus,
        'restart-repair',
      );
    }
  }

  hasRestoredStream(streamId: StreamTabId): boolean {
    return this.restoredStreams.has(streamId);
  }

  forgetActiveRestoredStreams(
    activeExecutionIds: ReadonlySet<string>,
    streamExecutionIds?: ReadonlyMap<StreamTabId, string>,
  ): void {
    for (const [streamId, snapshot] of this.restoredStreams) {
      const executionId =
        snapshot.executionId ?? streamExecutionIds?.get(streamId);
      if (!executionId || !activeExecutionIds.has(executionId)) {
        continue;
      }
      this.restoredStreams.delete(streamId);
      this.restoredDisplaySent.delete(streamId);
      this.restoredDisplayInFlight.delete(streamId);
      this.liveSnapshotFacts.delete(streamId);
    }
  }

  // ── Presentation events ──────────────────────────────────────────────────

  handlePresentationEvent<K extends DesktopPresentationEvent>(
    event: K,
    payload: DesktopPresentationPayloads[K],
  ): void {
    // A headless run may still hold the owning bridge's `hostChannel.emit`
    // closure that routes here after the desktop window closed and this bridge
    // was disposed. Applying events post-dispose would repopulate the ghost /
    // live stream maps that `dispose()` just cleared, re-persist snapshots, and
    // route/show-error into a closed renderer. Mirror the ProgressBackend guard
    // from #7372 (its sibling caller reached from the same fan-out point) so
    // this second route also no-ops once disposed.
    if (this.disposed) return;
    switch (event) {
      case 'requestEnsureProgressView':
        this.opts.routeToProgress();
        return;
      case 'requestShowError': {
        const data = payload as RequestShowErrorPayload;
        this.opts.onShowError(data.message);
        return;
      }
      case 'requestShowInstruction': {
        // No second dialog surface: fold the instruction into the same
        // error-dialog path `requestShowError` uses (one dialog per host).
        const data = payload as RequestShowInstructionPayload;
        this.opts.onShowError(data.message);
        return;
      }
    }
  }

  handleSessionEvent(event: SessionEvent): void {
    if (this.disposed) return;
    if (event.scope === 'session') {
      this.handleSessionFact(event.event);
      return;
    }
    this.handleRunEvent(event.event);
  }

  // ── Restored display ─────────────────────────────────────────────────────

  /**
   * Restore a ghost (prior-session) stream's persisted sidecar display from
   * `streamData/` the first time it becomes active — todos / plan / per-run
   * usage / output files — matching what the CLI and extension show on resume.
   * Sent once per stream; only durable data is restored (no liveness).
   */
  sendRestoredDisplay(streamId: StreamTabId): void {
    if (
      !this.restoredStreams.has(streamId) ||
      this.restoredDisplaySent.has(streamId) ||
      this.restoredDisplayInFlight.has(streamId)
    ) {
      return;
    }
    this.restoredDisplayInFlight.add(streamId);
    void this.opts.state.snapshots
      .read(streamId)
      .then((snap) => {
        if (
          streamId !== this.opts.getActiveStream() ||
          !this.restoredStreams.has(streamId)
        ) {
          return;
        }
        // The persisted snapshot is authoritative for a restored stream: send
        // todos/plan verbatim so an intentionally-empty list or null plan CLEARS
        // any stale renderer state instead of being skipped — matching the CLI
        // and extension resume paths (both restore the persisted value as-is).
        const send = this.opts.sendMessage;
        send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_TODOS,
          stream: streamId,
          todos: snap.todos,
        });
        send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_PLAN,
          stream: streamId,
          plan: snap.plan,
        });
        for (const [runId, usage] of Object.entries(snap.runUsage)) {
          send({
            command: PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE,
            stream: streamId,
            runId,
            usage,
          });
        }
        if (Object.keys(snap.outputFilesByRound).length > 0) {
          send({
            command: PROGRESS_VIEW_COMMANDS.UPDATE_FILES,
            stream: streamId,
            rounds: snap.outputFilesByRound,
          });
        }
        if (Object.keys(snap.missingOutputsByRound).length > 0) {
          send({
            command: PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS,
            stream: streamId,
            rounds: snap.missingOutputsByRound,
          });
        }
        if (Object.keys(snap.compileFailuresByRound).length > 0) {
          send({
            command: PROGRESS_VIEW_COMMANDS.UPDATE_COMPILE_FAILURES,
            stream: streamId,
            rounds: snap.compileFailuresByRound,
            reset: true,
          });
        }
        this.restoredDisplaySent.add(streamId);
      })
      .catch((error: unknown) => {
        this.opts.logger.warn(`Failed to restore display for ${streamId}`, {
          data: error,
        });
      })
      .finally(() => {
        this.restoredDisplayInFlight.delete(streamId);
      });
  }

  // ── Stream lifecycle ──────────────────────────────────────────────────────

  onStreamDeleted(streamId: StreamTabId): void {
    this.liveStreams.delete(streamId);
    this.removePersistedStream(streamId);
    this.restoredDisplaySent.delete(streamId);
    this.restoredDisplayInFlight.delete(streamId);
    this.liveSnapshotFacts.delete(streamId);
  }

  async onAllStreamsDeleted(): Promise<void> {
    this.restoredStreams.clear();
    this.restoredDisplaySent.clear();
    this.restoredDisplayInFlight.clear();
    this.liveStreams.clear();
    this.liveSnapshotFacts.clear();
    if (this.opts.streamSnapshotStore) {
      try {
        await this.opts.streamSnapshotStore.replaceAll([]);
      } catch (error: unknown) {
        this.opts.logger.warn('Failed to clear stream snapshot store', {
          data: toLogData(error),
        });
      }
    }
  }

  // ── Dispose ──────────────────────────────────────────────────────────────

  dispose(): void {
    this.disposed = true;
    this.restoredStreams.clear();
    this.restoredDisplaySent.clear();
    this.restoredDisplayInFlight.clear();
    this.liveStreams.clear();
    this.liveSnapshotFacts.clear();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private persistStreamSnapshot(
    streamId: StreamTabId,
    overrides: Partial<
      Pick<RestoredStreamSnapshot, 'executionId' | 'lastKnownStatus'>
    > = {},
  ): void {
    const store = this.opts.streamSnapshotStore;
    if (!store) return;

    const knownFacts = { ...this.liveSnapshotFacts.get(streamId) };
    if (overrides.executionId !== undefined) {
      knownFacts.executionId = overrides.executionId;
    }
    if (overrides.lastKnownStatus !== undefined) {
      knownFacts.lastKnownStatus = overrides.lastKnownStatus;
    }
    this.liveSnapshotFacts.set(streamId, knownFacts);
    const taskState = this.opts.state.snapshots.getTaskState(streamId);
    const info = buildStreamInfo(this.opts.state, streamId, 'all');
    const restored = this.restoredStreams.get(streamId);
    const currentStatus = this.opts.streamStatus.get(streamId);
    const snapshot: RestoredStreamSnapshot = {
      streamId,
      label: info?.label ?? restored?.label ?? streamId,
      agent: info?.agent ?? restored?.agent,
      agentCategory:
        info?.agentCategory ??
        restored?.agentCategory ??
        AgentCategory.Workflow,
      inputFile: info?.inputFile || restored?.inputFile,
      instruction: taskState?.agentConfig.instruction || restored?.instruction,
      lastKnownStatus:
        knownFacts.lastKnownStatus ??
        currentStatus ??
        restored?.lastKnownStatus ??
        STREAM_PHASE.COMPLETED,
      description: info?.description ?? restored?.description,
      executionId:
        knownFacts.executionId ?? info?.executionId ?? restored?.executionId,
      parentStreamId: info?.parentStreamId ?? restored?.parentStreamId,
      creationTimestamp:
        info?.creationTimestamp ?? restored?.creationTimestamp ?? Date.now(),
      lastTimestamp:
        this.opts.state.streamLogs.getLastTimestamp(streamId) ??
        restored?.lastTimestamp,
      persistedAt: Date.now(),
    };
    void store.upsert(snapshot).catch((error: unknown) => {
      this.opts.logger.warn('Failed to persist stream snapshot', {
        data: toLogData(error),
      });
    });
  }

  private removePersistedStream(streamId: StreamTabId): void {
    this.restoredStreams.delete(streamId);
    this.liveSnapshotFacts.delete(streamId);
    const store = this.opts.streamSnapshotStore;
    if (!store) return;
    void store.remove(streamId).catch((error: unknown) => {
      this.opts.logger.warn('Failed to remove persisted stream snapshot', {
        data: toLogData(error),
      });
    });
  }

  private handleSessionFact(fact: SessionFact): void {
    switch (fact.type) {
      case 'setActiveStream':
        this.handleSetActiveStream(fact.payload);
        return;
      case 'updateStreamStatus':
        this.handleStreamStatusFact(fact.payload.streamId, fact.payload.status);
        return;
      case 'updateStreamDescription':
        this.persistStreamSnapshot(fact.payload.streamId);
        return;
      case 'setParentStream':
        this.persistStreamSnapshot(fact.payload.childStreamId);
        return;
      case 'goalStateChanged':
        this.handleGoalStateChanged(fact.payload.streamId);
        return;
      case 'inquiryThreadUpdated':
      case 'clearMissingOutputs':
      case 'updateQueuedFollowUps':
      case 'followUpSent':
        return;
      case 'removeStream':
        // Shared ProgressBackend fact handling owns lifecycle deletion.
        return;
    }
    assertNever(fact, 'Unhandled desktop session fact');
  }

  private handleRunEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'run.config':
        this.handleRunConfigFact(event.streamId, event.executionId);
        return;
      case 'status':
        this.handleStreamStatusFact(event.streamId, event.phase);
        return;
      default:
        return;
    }
  }

  private handleSetActiveStream(payload: SetActiveStreamPayload): void {
    if (!payload.streamId) {
      this.opts.state.activeStream = '';
      this.opts.sendMessage({
        command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
        activeStream: '',
      });
      return;
    }
    if (payload.suppressViewSwitch !== true) {
      this.opts.routeToProgress();
      this.sendRestoredDisplay(payload.streamId);
    }
  }

  private handleRunConfigFact(
    streamId: StreamTabId,
    executionId?: RestoredStreamSnapshot['executionId'],
  ): void {
    this.liveStreams.add(streamId);
    this.opts.state.streamLogs.ensureStream(streamId);
    this.restoredStreams.delete(streamId);
    this.persistStreamSnapshot(streamId, { executionId });
  }

  private handleStreamStatusFact(
    streamId: StreamTabId,
    lastKnownStatus?: RestoredStreamSnapshot['lastKnownStatus'],
  ): void {
    this.liveStreams.add(streamId);
    this.restoredStreams.delete(streamId);
    this.persistStreamSnapshot(streamId, { lastKnownStatus });
  }

  private handleGoalStateChanged(streamId: StreamTabId): void {
    const goal = GoalStore.getForStream(streamId);
    this.opts.onGoalStateChanged(streamId, isGoalInFlight(goal), {
      status: goal?.status,
      objective: goal?.objective,
    });
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a desktop session-progress bridge that owns ghost-stream hydration,
 * stream-snapshot persistence, restored-display sending, session/run fact
 * handling, and window-local presentation requests.
 */
export function createDesktopSessionProgressBridge(
  options: DesktopSessionProgressBridgeOptions,
): DesktopSessionProgressBridge {
  return new DesktopSessionProgressBridgeImpl(options);
}
