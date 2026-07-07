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
import type { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import {
  STREAM_PHASE,
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
  /** Called when a `requestShowError` event fires. */
  onShowError: (message: string) => void;
}

// ── Public interface ────────────────────────────────────────────────────────

export interface DesktopProgressEventBridge {
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
   * Handle a progress event emitted through the runtime host.
   *
   * Applies the desktop-specific rail update (persist snapshot, remove ghost,
   * route-to-progress, show root errors) for events delivered through the
   * owning window's runtime host or session projection path.
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

  /** Tear down local state and ignore any late runtime-host events. */
  dispose(): void;
}

// ── Implementation ──────────────────────────────────────────────────────────

class DesktopProgressEventBridgeImpl implements DesktopProgressEventBridge {
  readonly restoredStreams = new Map<StreamTabId, RestoredStreamSnapshot>();

  /** Ghost streams whose persisted display has already been restored this session. */
  private readonly restoredDisplaySent = new Set<StreamTabId>();
  /** Ghost streams with an async persisted-display restore already pending. */
  private readonly restoredDisplayInFlight = new Set<StreamTabId>();
  /** Streams that became live in this bridge and must not be restored as ghosts. */
  private readonly liveStreams = new Set<StreamTabId>();

  /** True once `dispose()` has torn down this bridge. */
  private disposed = false;

  constructor(private readonly opts: DesktopProgressEventBridgeOptions) {
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
    // reach this bridge through `DesktopProgressBridge.handleProgressEvent` and
    // then `onProgressEvent`. Do not subscribe this collaborator to the
    // process-wide bus; doing so would make root UI actions cross window
    // boundaries and outlive the owning renderer.
  }

  // ── Query ───────────────────────────────────────────────────────────────

  hydrateRestoredStreams(): void {
    const hydrated = this.opts.streamSnapshotStore?.hydrated ?? [];
    this.restoredStreams.clear();
    for (const snapshot of hydrated) {
      if (this.liveStreams.has(snapshot.streamId)) continue;
      this.restoredStreams.set(snapshot.streamId, snapshot);
      this.opts.state.streamLogs.ensureStream(snapshot.streamId);
      this.opts.state.updateStreamHints(snapshot.streamId, {
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
    }
  }

  // ── Progress events ──────────────────────────────────────────────────────

  onProgressEvent<K extends keyof ProgressEventPayloads>(
    event: K,
    payload: ProgressEventPayloads[K],
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
        this.liveStreams.add(data.streamId);
        this.opts.state.streamLogs.ensureStream(data.streamId);
        this.restoredStreams.delete(data.streamId);
        this.persistStreamSnapshot(data.streamId);
        return;
      }
      case 'updateStreamStatus': {
        const data = payload as ProgressEventPayloads['updateStreamStatus'];
        this.liveStreams.add(data.streamId);
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
      case 'goalStateChanged': {
        const data = payload as ProgressEventPayloads['goalStateChanged'];
        const goal = GoalStore.getForStream(data.streamId);
        this.opts.onGoalStateChanged(data.streamId, isGoalInFlight(goal), {
          status: goal?.status,
          objective: goal?.objective,
        });
        return;
      }
      case 'requestEnsureProgressView':
        this.opts.routeToProgress();
        return;
      case 'requestShowError': {
        const data = payload as ProgressEventPayloads['requestShowError'];
        this.opts.onShowError(data.message);
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
    this.liveStreams.delete(streamId);
    this.removePersistedStream(streamId);
    this.restoredDisplaySent.delete(streamId);
    this.restoredDisplayInFlight.delete(streamId);
  }

  async onAllStreamsDeleted(): Promise<void> {
    this.restoredStreams.clear();
    this.restoredDisplaySent.clear();
    this.restoredDisplayInFlight.clear();
    this.liveStreams.clear();
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
    this.disposed = true;
    this.restoredStreams.clear();
    this.restoredDisplaySent.clear();
    this.restoredDisplayInFlight.clear();
    this.liveStreams.clear();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private persistStreamSnapshot(streamId: StreamTabId): void {
    const store = this.opts.streamSnapshotStore;
    if (!store) return;

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
        currentStatus ?? restored?.lastKnownStatus ?? STREAM_PHASE.COMPLETED,
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
