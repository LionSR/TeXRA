/**
 * Desktop progress-event bridge.
 *
 * Extracted from DesktopProgressBridge to own the ghost-stream hydration,
 * stream-snapshot persistence, restored-display sending, and progress-event →
 * rail-update translation.  The parent bridge composes this as a focused
 * collaborator and keeps runtime-host, approval, resume, and stream-lifecycle
 * wiring.
 *
 * This is Slice 1 of the desktopAgentExecution.ts refactor (issue #6329).
 */

import type { AgentTrace } from '@agent/trace';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { bus, type ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import {
  STREAM_STATUS,
  type ProgressViewOutboundMessage,
  type RestoredStreamSnapshot,
  type StreamTabId,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas/agent';
import { isGoalInFlight, type GoalStatus } from '@shared/schemas/goal';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc/progressViewCommands';
import { buildStreamInfo } from '@shared/progressView/backend/streamInfoUtils';
import type { ProgressViewState } from '@shared/progressView/backend/state/ProgressViewState';
import { GoalStore } from '@tools/goal';
import type { DesktopStreamSnapshotStore } from './desktopStreamSnapshot.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface DesktopProgressEventBridgeOptions {
  /** The owning bridge's progress-view state. */
  state: ProgressViewState;
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
  /** Called when a `requestShowError` event fires. */
  onShowError: (message: string) => void;
}

// ── Public interface ────────────────────────────────────────────────────────

export interface DesktopProgressEventBridge {
  /** All currently-hydrated ghost streams (keyed by streamId). */
  readonly restoredStreams: ReadonlyMap<StreamTabId, RestoredStreamSnapshot>;

  /** True when a ghost stream with the given id exists. */
  hasRestoredStream(streamId: StreamTabId): boolean;

  /**
   * Handle a progress event emitted through the runtime host.
   *
   * The owning bridge MUST still call `bus.emit(event, payload)` itself —
   * this method only applies the desktop-specific rail update (persist
   * snapshot, remove ghost, route-to-progress).
   */
  onProgressEvent<K extends keyof ProgressEventPayloads>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void;

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

  /** Tear down event-bus subscriptions. */
  dispose(): void;
}

// ── Implementation ──────────────────────────────────────────────────────────

class DesktopProgressEventBridgeImpl implements DesktopProgressEventBridge {
  readonly restoredStreams = new Map<StreamTabId, RestoredStreamSnapshot>();

  /** Ghost streams whose persisted display has already been restored this session. */
  private readonly restoredDisplaySent = new Set<StreamTabId>();
  /** Ghost streams with an async persisted-display restore already pending. */
  private readonly restoredDisplayInFlight = new Set<StreamTabId>();

  private readonly unsubscribe: () => void;

  constructor(private readonly opts: DesktopProgressEventBridgeOptions) {
    // Hydrate previously-persisted "ghost" streams so the rail shows
    // the user's prior runs at launch (audit item D / trajectory #19).
    // We seed creation timestamps, statuses, descriptions, executionIds,
    // and categories from the snapshot — but NOT taskState, since we
    // can't resurrect runtime state. The renderer will show these as
    // stopped/orphaned entries; "Resume run" funnels back through the
    // existing storage-backed resume path when an executionId is
    // available, otherwise falls back to "start fresh".
    const hydrated = opts.streamSnapshotStore?.hydrated ?? [];
    for (const snapshot of hydrated) {
      this.restoredStreams.set(snapshot.streamId, snapshot);
      opts.state.streamLogs.ensureStream(snapshot.streamId);
      opts.state.updateStreamHints(snapshot.streamId, {
        agent: snapshot.agent,
        agentCategory: snapshot.agentCategory,
        inputFile: snapshot.inputFile,
        creationTimestamp: snapshot.creationTimestamp,
        executionId: snapshot.executionId,
        parentStreamId: snapshot.parentStreamId,
        description: snapshot.description,
      });
      StreamStatusService.set(snapshot.streamId, snapshot.lastKnownStatus, {
        emit: false,
      });
    }

    // Subscribe to progress-relevant event-bus channels.
    const unsubscribeGoal = bus.on('goalStateChanged', ({ streamId }) => {
      const goal = GoalStore.getForStream(streamId);
      opts.onGoalStateChanged(streamId, isGoalInFlight(goal), {
        status: goal?.status,
        objective: goal?.objective,
      });
    });
    const unsubscribeEnsureProgress = bus.on(
      'requestEnsureProgressView',
      () => {
        opts.routeToProgress();
      },
    );
    // Run failures surface only through this event for root runs; without a
    // subscriber the message dies in the main process and the rail shows a
    // bare ERROR status.
    const unsubscribeShowError = bus.on('requestShowError', ({ message }) => {
      opts.onShowError(message);
    });
    this.unsubscribe = () => {
      unsubscribeGoal();
      unsubscribeEnsureProgress();
      unsubscribeShowError();
    };
  }

  // ── Query ───────────────────────────────────────────────────────────────

  hasRestoredStream(streamId: StreamTabId): boolean {
    return this.restoredStreams.has(streamId);
  }

  // ── Progress events ──────────────────────────────────────────────────────

  onProgressEvent<K extends keyof ProgressEventPayloads>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void {
    switch (event) {
      case 'setActiveStream': {
        const data = payload as ProgressEventPayloads['setActiveStream'];
        if (!data.streamId) {
          this.opts.state.activeStream = '';
          this.opts.sendMessage({
            command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
            activeStream: '',
          });
          return;
        }
        if (data.suppressViewSwitch !== true) {
          this.opts.routeToProgress();
          this.sendRestoredDisplay(data.streamId);
        }
        return;
      }
      case 'setTaskState': {
        const data = payload as ProgressEventPayloads['setTaskState'];
        this.opts.state.streamLogs.ensureStream(data.streamId);
        this.restoredStreams.delete(data.streamId);
        this.persistStreamSnapshot(data.streamId);
        return;
      }
      case 'updateStreamStatus': {
        const data = payload as ProgressEventPayloads['updateStreamStatus'];
        this.restoredStreams.delete(data.streamId);
        this.persistStreamSnapshot(data.streamId);
        return;
      }
      case 'updateStreamDescription': {
        const data =
          payload as ProgressEventPayloads['updateStreamDescription'];
        this.persistStreamSnapshot(data.streamId);
        return;
      }
      case 'setParentStream': {
        const data = payload as ProgressEventPayloads['setParentStream'];
        this.persistStreamSnapshot(data.childStreamId);
        return;
      }
      default:
        return;
    }
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
    this.removePersistedStream(streamId);
    this.restoredDisplaySent.delete(streamId);
    this.restoredDisplayInFlight.delete(streamId);
  }

  async onAllStreamsDeleted(): Promise<void> {
    this.restoredStreams.clear();
    this.restoredDisplaySent.clear();
    this.restoredDisplayInFlight.clear();
    if (this.opts.streamSnapshotStore) {
      try {
        await this.opts.streamSnapshotStore.replaceAll([]);
      } catch (error: unknown) {
        this.opts.logger.warn('Failed to clear stream snapshot store', {
          data: error instanceof Error ? error : { error },
        });
      }
    }
  }

  // ── Dispose ──────────────────────────────────────────────────────────────

  dispose(): void {
    this.unsubscribe();
    this.restoredStreams.clear();
    this.restoredDisplaySent.clear();
    this.restoredDisplayInFlight.clear();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private persistStreamSnapshot(streamId: StreamTabId): void {
    const store = this.opts.streamSnapshotStore;
    if (!store) return;

    const taskState = this.opts.state.snapshots.getTaskState(streamId);
    const info = buildStreamInfo(this.opts.state, streamId, 'all');
    const restored = this.restoredStreams.get(streamId);
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
        StreamStatusService.get(streamId) ??
        restored?.lastKnownStatus ??
        STREAM_STATUS.STOPPED,
      description: info?.description ?? restored?.description,
      executionId: info?.executionId ?? restored?.executionId,
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
        data: error instanceof Error ? error : { error },
      });
    });
  }

  private removePersistedStream(streamId: StreamTabId): void {
    this.restoredStreams.delete(streamId);
    const store = this.opts.streamSnapshotStore;
    if (!store) return;
    void store.remove(streamId).catch((error: unknown) => {
      this.opts.logger.warn('Failed to remove persisted stream snapshot', {
        data: error instanceof Error ? error : { error },
      });
    });
  }

}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a desktop progress-event bridge that owns ghost-stream hydration,
 * stream-snapshot persistence, restored-display sending, and progress-event →
 * rail-update translation.
 */
export function createDesktopProgressEventBridge(
  options: DesktopProgressEventBridgeOptions,
): DesktopProgressEventBridge {
  return new DesktopProgressEventBridgeImpl(options);
}
