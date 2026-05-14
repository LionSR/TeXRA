import { z } from 'zod';

import { AgentCategory } from '@agent/core/AgentDataclass';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { cleanupInactiveAgents } from '@agent/toolUse/ToolUseAgentRegistry';
import { toErrorMessage } from '@common/errors';
import { workspaceSM, WorkspaceStateKey } from '@common/state';
import { isInFlightStatus } from '@common/constants/streamStatus';
import { AgentLogger } from '@logger/AgentLogger';
import { StreamLogStore } from '@logger/StreamLogStore';
import { OutputFilesManager } from '@progressView/managers/OutputFilesManager';
import { UsageStatsManager } from '@progressView/managers/UsageStatsManager';
import { StreamMetaManager } from '@progressView/managers/StreamMetaManager';
import type { MementoStorage } from '@progressView/persistence/PersistentMapManager';
import {
  getStreamTabStore,
  deleteAllStreamData,
  mapStreamTabStorage,
} from '@progressView/persistence/StreamTabStore';
import {
  needsMigrationFromMemento,
  migrateFromMemento,
} from '@progressView/persistence/mementoMigration';
import {
  AgentCategoryFilterSchema,
  ContextStateDataSchema,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type ActiveChildInfo,
  type AgentCategoryFilter,
  type ConversationProgress,
  type ContextStateData,
  type StreamTabId,
  type TodoItem,
  type Plan,
  type WorkPlanSnapshot,
  WorkPlanSnapshotSchema,
} from '@shared/schemas';
import {
  PersistedState,
  createBackendStorage,
} from '@shared/state/PersistedState';

/** Ephemeral stream metadata hints, displayed before TaskState is fully populated. */
export const StreamHintsSchema = z.object({
  agentCategory: z.enum(AgentCategory).optional(),
  isRemote: z.boolean().optional(),
  creationTimestamp: z.number().optional(),
});

export type StreamHints = z.infer<typeof StreamHintsSchema>;

/** Ephemeral session state per stream (not persisted). */
const StreamSessionStateSchema = z.object({
  hints: StreamHintsSchema.prefault({}),
  workPlan: WorkPlanSnapshotSchema.prefault({}),
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

/** Clean up tool-use agent registry based on currently active streams. */
export function cleanupToolUseAgentRegistry(meta: StreamMetaManager): void {
  cleanupInactiveAgents(meta.getActiveToolUseStreams());
}

/**
 * Core state management for the progress view.
 *
 * Coordinates four persistence managers (streamLogs, outputFiles, usageStats,
 * meta) plus ephemeral in-memory state and preferences. Workflow instructions
 * live in the log stream (new runs write them directly; legacy runs are
 * backfilled there during load), not in separate progress-view state.
 */
export class ProgressViewState {
  // -- Persistence managers ---------------------------------------------------
  readonly streamLogs: StreamLogStore;
  readonly outputFiles: OutputFilesManager;
  readonly usageStats: UsageStatsManager;
  readonly meta: StreamMetaManager;

  // -- Preferences ------------------------------------------------------------
  private _prefs!: PersistedState<ProgressViewPrefs>;

  // -- Ephemeral state (session-only, not persisted) --------------------------
  private _streamStates = new Map<StreamTabId, StreamExecutionState>();
  private _sessionState = new Map<StreamTabId, StreamSessionState>();

  private readonly storage: MementoStorage;
  private readonly logger: AgentLogger;

  constructor(storage?: MementoStorage) {
    const resolvedStorage = storage ?? workspaceSM;
    if (!resolvedStorage) {
      throw new Error('workspace state manager is not initialized');
    }

    this.storage = resolvedStorage;
    this.logger = new AgentLogger('ProgressViewState');
    this._prefs = new PersistedState(
      createBackendStorage(resolvedStorage),
      WorkspaceStateKey.PROGRESS_VIEW_PREFS,
      ProgressViewPrefsSchema,
    );
    this.streamLogs = new StreamLogStore();
    AgentLogger.setStreamLogStore(this.streamLogs);
    this.outputFiles = new OutputFilesManager();
    this.usageStats = new UsageStatsManager();
    this.meta = new StreamMetaManager();
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
    if (!isInFlightStatus(StreamStatusService.get(streamId))) {
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

  setTodos(stream: StreamTabId, todos: TodoItem[]): void {
    const state = this.getOrCreateSession(stream);
    state.workPlan = WorkPlanSnapshotSchema.parse({
      ...state.workPlan,
      todos,
    });
  }

  getTodos(stream: StreamTabId): TodoItem[] {
    return this._sessionState.get(stream)?.workPlan.todos ?? [];
  }

  setPlan(stream: StreamTabId, plan: Plan | null): void {
    const state = this.getOrCreateSession(stream);
    state.workPlan = WorkPlanSnapshotSchema.parse({
      ...state.workPlan,
      plan,
      planSummary: plan?.summary ?? null,
    });
  }

  getPlan(stream: StreamTabId): Plan | null {
    return this._sessionState.get(stream)?.workPlan.plan ?? null;
  }

  getWorkPlan(stream: StreamTabId): WorkPlanSnapshot {
    return (
      this._sessionState.get(stream)?.workPlan ??
      WorkPlanSnapshotSchema.parse({})
    );
  }

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

  getAllStreamStates(): Record<StreamTabId, StreamExecutionState> {
    return Object.fromEntries(this._streamStates.entries());
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
    StreamStatusService.clear(stream, { emit: false });
    this.outputFiles.evict(stream);
    this.usageStats.evict(stream);
    this.meta.evict(stream);
    this._sessionState.delete(stream);
    this._streamStates.delete(stream);

    // Delete from disk: stream log file + stream data directory
    const store = getStreamTabStore(stream);
    await Promise.all([this.streamLogs.delete(stream), store.clear()]);

    // Update active stream *after* deletion so keys() no longer includes it
    if (this._prefs.get('activeStream') === stream) {
      this._prefs.update({
        activeStream: this.streamLogs.keys()[0] || '',
      });
    }

    cleanupToolUseAgentRegistry(this.meta);
  }

  async clearAll(): Promise<void> {
    this.logger.warn(
      '[Persistence] clearAll() called - this will delete all persisted data!',
      { data: { stack: new Error().stack } },
    );

    // Clear in-memory state
    StreamStatusService.clearAll({ emit: false });
    this.outputFiles.evictAll();
    this.usageStats.evictAll();
    this.meta.evictAll();
    this._sessionState.clear();
    this._streamStates.clear();
    this._prefs.reset();

    // Delete from disk
    await Promise.all([this.streamLogs.clear(), deleteAllStreamData()]);

    cleanupToolUseAgentRegistry(this.meta);
  }

  async load(): Promise<void> {
    this.logger.info('[Persistence] Starting state load from storage');

    // Load stream logs first — they define the set of known streams
    await this.streamLogs.load(this.storage);

    const streamIds = this.streamLogs.keys();
    this.logger.info(`[Persistence] Discovered ${streamIds.length} stream(s)`);

    // Check if we need one-time migration from workspace state
    const shouldMigrate = await needsMigrationFromMemento(
      this.storage,
      streamIds,
    );
    if (shouldMigrate) {
      await migrateFromMemento(
        this.storage,
        this.streamLogs.keys(),
        this.logger,
      );
      await this.loadManagers(this.streamLogs.keys());
    } else {
      await this.loadManagers(streamIds);
    }

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
    cleanupToolUseAgentRegistry(this.meta);

    this.logger.info('[Persistence] State load complete');
  }

  /**
   * Flush pending writes from all managers.
   */
  async flush(): Promise<void> {
    AgentLogger.flushPendingStreamUpdates();
    await Promise.all([
      this.streamLogs.flush(),
      this.meta.flush(),
      this.outputFiles.flush(),
      this.usageStats.flush(),
    ]);
  }

  // -- Private helpers --------------------------------------------------------

  private async loadManagers(streamIds: StreamTabId[]): Promise<void> {
    await Promise.all([
      this.outputFiles.load(streamIds),
      this.usageStats.load(streamIds),
      this.meta.load(streamIds),
    ]);
  }

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
            : Math.max(0, Math.min(baseTimestamp, firstTimestamp - 1));

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
      const fallback = this.streamLogs.keys()[0] ?? '';
      if (fallback !== savedActiveStream) {
        this._prefs.update({ activeStream: fallback });
      }
    }
  }
}
