import { z } from 'zod';

import {
  setDefaultStreamLogStore,
  StreamLogStore,
  StreamSnapshotStore,
} from '@transcript';
import type { AgentTrace } from '@agent/trace';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  clearAllRuntimeStreamStatuses,
  clearRuntimeStreamStatus,
  isRuntimeStreamInFlight,
} from '@agent/runtime/streamControl';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { toErrorMessage } from '@common/errors';
import { createChannelTrace } from '@logger';
import {
  AgentCategoryFilterSchema,
  ContextStateDataSchema,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  StreamTabInfoSchema,
  type ActiveChildInfo,
  type AgentCategoryFilter,
  type ConversationProgress,
  type ContextStateData,
  type StreamTabId,
} from '@shared/schemas';
import type { MementoStorage } from '@shared/progressView/backend/persistence/PersistentMapManager';
import {
  getStreamTabStore,
  mapStreamTabStorage,
} from '@shared/progressView/backend/persistence/StreamTabStore';
import {
  PersistedState,
  createBackendStorage,
} from '@shared/state/PersistedState';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { clamp } from '@utils/core';

/** Ephemeral stream metadata hints, displayed before TaskState is fully populated. */
export const StreamHintsSchema = StreamTabInfoSchema.pick({
  agent: true,
  agentCategory: true,
  inputFile: true,
  isRemote: true,
  creationTimestamp: true,
  executionId: true,
  parentStreamId: true,
  description: true,
}).partial();

export type StreamHints = z.infer<typeof StreamHintsSchema>;

/** Ephemeral session state per stream (not persisted). */
const StreamSessionStateSchema = z.object({
  hints: StreamHintsSchema.prefault({}),
  contextState: ContextStateDataSchema.nullable().prefault(null),
});

type StreamSessionState = z.output<typeof StreamSessionStateSchema>;

/** Active stream identifier, or empty string when no stream is selected. */
export type ActiveStreamId = StreamTabId | '';

/** Schema for consolidated progress view preferences. */
const ProgressViewPrefsSchema = z.object({
  activeStream: z.string().prefault('') as z.ZodType<ActiveStreamId>,
  agentCategoryFilter: AgentCategoryFilterSchema.prefault('all'),
});

type ProgressViewPrefs = z.infer<typeof ProgressViewPrefsSchema>;

/**
 * Backend-owned ephemeral counters, updated during streaming.
 */
export interface StreamExecutionState {
  kind: (typeof AgentCategory)[keyof typeof AgentCategory];
  conversationProgress: ConversationProgress;
  activeSubagents: ActiveChildInfo[];
  finishedSubagentCount: number;
  activeProcesses: ActiveChildInfo[];
  finishedProcessCount: number;
}

/**
 * Per-stream child-activity badge counts, projected from
 * {@link StreamExecutionState}. Sent to the webview on tab switch and whenever
 * subagent/process activity changes.
 */
export type StreamBadgeSnapshot = Pick<
  StreamExecutionState,
  | 'activeSubagents'
  | 'finishedSubagentCount'
  | 'activeProcesses'
  | 'finishedProcessCount'
>;

function createExecutionState(
  kind: (typeof AgentCategory)[keyof typeof AgentCategory],
): StreamExecutionState {
  return {
    kind,
    conversationProgress: { conversationTurns: 0, toolCallCount: 0 },
    activeSubagents: [],
    finishedSubagentCount: 0,
    activeProcesses: [],
    finishedProcessCount: 0,
  };
}

/**
 * Core state management for the progress view.
 *
 * Coordinates two persistence stores — `streamLogs` (transcript) and
 * `snapshots` (all per-stream sidecar: output files, usage, todos, plan, and
 * meta) — plus ephemeral in-memory execution state and preferences. Workflow
 * instructions live in the log stream (new runs write them directly; legacy
 * runs are backfilled there during load), not in separate progress-view state.
 */
export class ProgressViewState {
  // -- Persistence managers ---------------------------------------------------
  readonly streamLogs: StreamLogStore;
  /** Single owner of all per-stream sidecar state (output files, usage, todos,
   * plan, taskState/executionId/parent/description + meta queries). */
  readonly snapshots: StreamSnapshotStore;

  // -- Preferences ------------------------------------------------------------
  private _prefs!: PersistedState<ProgressViewPrefs>;

  // -- Ephemeral state (session-only, not persisted) --------------------------
  private _streamStates = new Map<StreamTabId, StreamExecutionState>();
  private _sessionState = new Map<StreamTabId, StreamSessionState>();

  private readonly logger: AgentTrace;
  private readonly session: SessionHandle;

  constructor(
    storage: MementoStorage,
    snapshots = new StreamSnapshotStore(),
    session: SessionHandle = defaultSession(),
  ) {
    this.logger = createChannelTrace('ProgressViewState');
    this.session = session;
    this._prefs = new PersistedState(
      createBackendStorage(storage),
      WorkspaceStateKey.PROGRESS_VIEW_PREFS,
      ProgressViewPrefsSchema,
    );
    this.streamLogs = new StreamLogStore();
    setDefaultStreamLogStore(this.streamLogs);
    this.snapshots = snapshots;
  }

  /** Drop interruptible handles whose stream sidecar was removed. */
  pruneInterruptHandles(): void {
    this.session.interrupts.retainOnly(this.snapshots.getTaskStateStreams());
  }

  // -- Preferences ------------------------------------------------------------

  get activeStream(): ActiveStreamId {
    return this._prefs.get('activeStream');
  }

  set activeStream(stream: ActiveStreamId) {
    this._prefs.update({ activeStream: stream });
  }

  /**
   * Compute which stream should be active given available streams (pure query).
   */
  pickValidActiveStream(availableStreams: StreamTabId[]): StreamTabId {
    const current = this._prefs.get('activeStream');
    if (availableStreams.includes(current)) {
      return current;
    }
    return availableStreams[0] || current;
  }

  /**
   * Release a previously-active stream's entries if its status is not
   * in-flight. `ProgressEventHandler.setStreamStatus` intentionally skips
   * eviction for the active tab, so every active-stream switch path must
   * call this on the stream being moved away from to close the loop.
   */
  releasePreviousActive(streamId: StreamTabId): void {
    if (!isRuntimeStreamInFlight(streamId)) {
      this.streamLogs.releaseEntries(streamId);
    }
  }

  get agentCategoryFilter(): AgentCategoryFilter {
    return this._prefs.get('agentCategoryFilter');
  }

  set agentCategoryFilter(filter: AgentCategoryFilter) {
    if (!AgentCategoryFilterSchema.safeParse(filter).success) {
      this.logger.warn(`Invalid agent filter: ${filter}, defaulting to 'all'`);
      filter = 'all';
    }
    this._prefs.update({ agentCategoryFilter: filter });
  }

  // -- Ephemeral session state ------------------------------------------------

  private getOrCreateSession(stream: StreamTabId): StreamSessionState {
    let state = this._sessionState.get(stream);
    if (!state) {
      state = StreamSessionStateSchema.parse({});
      this._sessionState.set(stream, state);
    }
    return state;
  }

  updateStreamHints(streamTabId: StreamTabId, hints: StreamHints): void {
    const state = this.getOrCreateSession(streamTabId);
    const creationTimestamp =
      state.hints.creationTimestamp ?? hints.creationTimestamp ?? Date.now();
    state.hints = StreamHintsSchema.parse({
      ...state.hints,
      ...hints,
      creationTimestamp,
    });
  }

  getStreamHints(streamTabId: StreamTabId): StreamHints {
    return this._sessionState.get(streamTabId)?.hints ?? {};
  }

  clearStreamHints(streamTabId: StreamTabId): void {
    const state = this._sessionState.get(streamTabId);
    if (state) {
      state.hints = {};
    }
  }

  // todos/plan are owned + persisted by StreamSnapshotStore (workPlan.json).

  getContextState(stream: StreamTabId): ContextStateData | undefined {
    return this._sessionState.get(stream)?.contextState ?? undefined;
  }

  // -- Ephemeral execution state ----------------------------------------------

  getOrCreateStreamState(
    stream: StreamTabId,
    agentCategory: (typeof AgentCategory)[keyof typeof AgentCategory],
  ): StreamExecutionState {
    const existing = this._streamStates.get(stream);
    if (!existing || existing.kind !== agentCategory) {
      const state = createExecutionState(agentCategory);
      this._streamStates.set(stream, state);
      return state;
    }
    return existing;
  }

  updateStreamState(
    stream: StreamTabId,
    updater: (prev: StreamExecutionState) => StreamExecutionState,
  ): void {
    const current = this._streamStates.get(stream);
    if (current) {
      this._streamStates.set(stream, updater(current));
    }
  }

  /** Reset per-run ephemeral counters when a new run starts on the same stream. */
  resetFinishedChildCounters(stream: StreamTabId): void {
    const current = this._streamStates.get(stream);
    if (!current) return;

    const needsReset =
      current.finishedSubagentCount !== 0 ||
      current.finishedProcessCount !== 0 ||
      current.conversationProgress.conversationTurns !== 0 ||
      current.conversationProgress.toolCallCount !== 0;

    if (needsReset) {
      this._streamStates.set(stream, {
        ...current,
        finishedSubagentCount: 0,
        finishedProcessCount: 0,
        conversationProgress: { conversationTurns: 0, toolCallCount: 0 },
      });
    }
  }

  getStreamState(stream: StreamTabId): StreamExecutionState | undefined {
    return this._streamStates.get(stream);
  }

  getAllStreamStates(): ReadonlyMap<StreamTabId, StreamExecutionState> {
    return this._streamStates;
  }

  async endRunningTaskGroups(
    now: number = Date.now(),
    streamIds?: readonly StreamTabId[],
  ): Promise<StreamTabId[]> {
    const affectedFromLogs = await this.streamLogs.endRunningGroups(
      now,
      streamIds,
    );
    if (affectedFromLogs.length > 0) {
      await this.streamLogs.save();
    }
    return affectedFromLogs;
  }

  // -- Lifecycle --------------------------------------------------------------

  async clearStream(stream: StreamTabId): Promise<void> {
    // Clear in-memory state
    clearRuntimeStreamStatus(stream);
    this._sessionState.delete(stream);
    this._streamStates.delete(stream);

    // Delete from disk: stream log file + stream data directory (the snapshot
    // store owns streamData/ — it evicts its own memory + removes the dir).
    await Promise.all([
      this.streamLogs.delete(stream),
      this.snapshots.deleteStream(stream),
    ]);

    // Update active stream *after* deletion so keys() no longer includes it.
    // `streamLogs.keys()` is ascending by creation time (load() sorts by
    // `firstTimestamp` ASC, and session additions are appended), but the
    // sidebar sorts newest-first — `.at(-1)` picks the topmost visible tab.
    if (this._prefs.get('activeStream') === stream) {
      this._prefs.update({
        activeStream: this.streamLogs.keys().at(-1) ?? '',
      });
    }

    this.pruneInterruptHandles();
  }

  async clearAll(): Promise<void> {
    this.logger.warn(
      '[Persistence] clearAll() called - this will delete all persisted data!',
      { data: { stack: new Error().stack } },
    );

    // Clear in-memory state
    clearAllRuntimeStreamStatuses();
    this._sessionState.clear();
    this._streamStates.clear();
    this._prefs.reset();

    // Delete from disk (snapshot store owns streamData/, evicts its own memory)
    await Promise.all([this.streamLogs.clear(), this.snapshots.deleteAll()]);

    this.pruneInterruptHandles();
  }

  async load(): Promise<void> {
    this.logger.info('[Persistence] Starting state load from storage');

    // Load stream logs first — they define the set of known streams
    await this.streamLogs.load();

    const streamIds = this.streamLogs.keys();
    this.logger.info(`[Persistence] Discovered ${streamIds.length} stream(s)`);

    await this.snapshots.load(streamIds);

    // Promote any pre-existing `runInstructions.json` disk files (from the
    // earlier memento→StreamTabStore migration) to the archival
    // `legacyInstructions.json` so older workflow tabs can still restore
    // their original instruction into the log stream.
    await mapStreamTabStorage(this.streamLogs.keys(), (id) =>
      getStreamTabStore(id)
        .migrateOnDiskRunInstructions()
        .catch(() => {}),
    );

    const restoredLegacyInstructionCount =
      await this.backfillLegacyWorkflowInstructions();
    if (restoredLegacyInstructionCount > 0) {
      this.logger.info(
        `[Persistence] Restored ${restoredLegacyInstructionCount} legacy workflow instruction(s) into stream logs`,
      );
    }

    this.logger.info('[Persistence] Managers loaded');

    this.validateActiveStream();
    this.pruneInterruptHandles();

    this.logger.info('[Persistence] State load complete');
  }

  /**
   * Flush pending writes from all managers.
   */
  async flush(): Promise<void> {
    this.session.flushPendingTraces();
    await Promise.all([this.streamLogs.flush(), this.snapshots.flush()]);
  }

  // -- Private helpers --------------------------------------------------------

  private async backfillLegacyWorkflowInstructions(): Promise<number> {
    let restoredCount = 0;

    await mapStreamTabStorage(this.streamLogs.keys(), async (streamId) => {
      try {
        const store = getStreamTabStore(streamId);
        const legacyInstruction = await store.readPreferredLegacyInstruction();
        if (!legacyInstruction) return;

        const text = legacyInstruction.text.trim();
        if (!text) return;

        await this.streamLogs.ensureLoaded(streamId);
        const log = this.streamLogs.get(streamId);
        if (!log) return;

        const alreadyPresent = log
          .getRange(0, log.head)
          .some(
            (entry) =>
              entry.type === STREAM_LOG_ENTRY_TYPES.LOG &&
              entry.messageType === MESSAGE_TYPES.USER_MESSAGE &&
              entry.text?.trim() === text,
          );
        if (alreadyPresent) return;

        const firstTimestamp = log.firstTimestamp;
        const baseTimestamp =
          legacyInstruction.timestamp ?? firstTimestamp ?? Date.now();
        const timestamp =
          firstTimestamp == null
            ? baseTimestamp
            : clamp(baseTimestamp, 0, firstTimestamp - 1);

        this.streamLogs.append(streamId, {
          id: `legacy-instruction:${streamId}:${timestamp}`,
          type: STREAM_LOG_ENTRY_TYPES.LOG,
          level: LOG_LEVELS.INFO,
          timestamp,
          messageType: MESSAGE_TYPES.USER_MESSAGE,
          text: legacyInstruction.text,
          data: { source: 'legacyInstruction' },
        });
        restoredCount++;
      } catch (err) {
        this.logger.warn(
          `[Persistence] Failed to backfill legacy instruction for ${streamId}: ${toErrorMessage(err)}`,
          { data: err },
        );
      }
    });

    return restoredCount;
  }

  /** Validate activeStream against available streams after load */
  private validateActiveStream(): void {
    const savedActiveStream = this._prefs.get('activeStream');
    if (!savedActiveStream || !this.streamLogs.has(savedActiveStream)) {
      // `streamLogs.keys()` is ascending by creation time (load() sorts by
      // `firstTimestamp` ASC), but the sidebar renders newest-first — pick
      // the last key so the fallback matches the topmost visible tab
      // instead of the oldest one at the bottom.
      const fallback = this.streamLogs.keys().at(-1) ?? '';
      if (fallback !== savedActiveStream) {
        this._prefs.update({ activeStream: fallback });
      }
    }
  }
}
