import { z } from 'zod';

import {
  AgentCategoryFilterSchema,
  ContextStateDataSchema,
  TodoItemSchema,
  type ActiveChildInfo,
  type AgentCategoryFilter,
  type ConversationProgress,
  type ContextStateData,
  type OutputFileInfo,
  type StorageKey,
  type StreamTabId,
  type TaskGroup,
  type TodoItem,
  type UpdateTaskGroupPayload,
} from '@shared/schemas';
import { StreamSortSchema, type StreamSort } from '@shared/streams/streamSort';
import {
  PersistedState,
  createBackendStorage,
} from '@shared/state/PersistedState';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { cleanupInactiveAgents } from '@agent/toolUse/ToolUseAgentRegistry';
import { workspaceSM, WorkspaceStateKey } from '@common/state';
import { AgentLogger } from '@logger/AgentLogger';
import { StreamLogStore } from '@logger/StreamLogStore';
import type { TaskState } from '@logger/TaskState';
import { OutputFilesManager } from '@progressView/managers/OutputFilesManager';
import { UsageStatsManager } from '@progressView/managers/UsageStatsManager';
import { StreamMetaManager } from '@progressView/managers/StreamMetaManager';
import { RunInstructionsManager } from '@progressView/managers/RunInstructionsManager';
import type { MementoStorage } from '@progressView/persistence/PersistentMapManager';
import {
  getStreamTabStore,
  deleteAllStreamData,
  STREAM_DATA_DIR,
} from '@progressView/persistence/StreamTabStore';
import {
  needsMigrationFromMemento,
  migrateFromMemento,
} from '@progressView/persistence/mementoMigration';
import { KVStore } from '@common/storage';

/** Ephemeral stream metadata hints, displayed before TaskState is fully populated. */
export const StreamHintsSchema = z.object({
  agentCategory: z.enum(AgentCategory).optional(),
  isRemote: z.boolean().optional(),
  hasMultipleOutputs: z.boolean().optional(),
  creationTimestamp: z.number().optional(),
});

export type StreamHints = z.infer<typeof StreamHintsSchema>;

/** Ephemeral session state per stream (not persisted). */
const StreamSessionStateSchema = z.object({
  hints: StreamHintsSchema.prefault({}),
  todos: z.array(TodoItemSchema).prefault([]),
  contextState: ContextStateDataSchema.nullable().prefault(null),
});

type StreamSessionState = z.output<typeof StreamSessionStateSchema>;

/** Active stream identifier, or empty string when no stream is selected. */
export type ActiveStreamId = StreamTabId | '';

/** Schema for consolidated progress view preferences. */
const ProgressViewPrefsSchema = z.object({
  activeStream: z.string().prefault('') as z.ZodType<ActiveStreamId>,
  streamSortOrder: StreamSortSchema.prefault('time'),
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

/**
 * Core state management for the progress view.
 *
 * Coordinates five persistence managers (streamLogs, outputFiles, usageStats,
 * meta, runInstructions) plus ephemeral in-memory state and preferences.
 */
export class ProgressViewState {
  // -- Persistence managers ---------------------------------------------------
  private _streamLogs: StreamLogStore;
  private _outputFiles: OutputFilesManager;
  private _usageStats: UsageStatsManager;
  private _meta: StreamMetaManager;
  private _runInstructions: RunInstructionsManager;

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
    this._streamLogs = new StreamLogStore();
    AgentLogger.setStreamLogStore(this._streamLogs);
    this._outputFiles = new OutputFilesManager();
    this._usageStats = new UsageStatsManager();
    this._meta = new StreamMetaManager();
    this._runInstructions = new RunInstructionsManager();
  }

  // -- Manager accessors (consistent pattern: consumers access directly) ------

  get streamLogs(): StreamLogStore {
    return this._streamLogs;
  }

  get outputFiles(): OutputFilesManager {
    return this._outputFiles;
  }

  get usageStats(): UsageStatsManager {
    return this._usageStats;
  }

  get meta(): StreamMetaManager {
    return this._meta;
  }

  get runInstructions(): RunInstructionsManager {
    return this._runInstructions;
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

  get streamSortOrder(): StreamSort {
    return this._prefs.get('streamSortOrder');
  }

  set streamSortOrder(order: StreamSort) {
    this._prefs.update({ streamSortOrder: order });
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
    this.getOrCreateSession(stream).todos = todos;
  }

  getTodos(stream: StreamTabId): TodoItem[] {
    return this._sessionState.get(stream)?.todos ?? [];
  }

  setContextState(stream: StreamTabId, contextState: ContextStateData): void {
    this.getOrCreateSession(stream).contextState = contextState;
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

  getStreamLastTimestamp(stream: StreamTabId): number | undefined {
    return this._streamLogs.getLastTimestamp(stream);
  }

  // -- Coordinator methods (cross-cutting side effects) -----------------------

  /**
   * Store task state and trigger coordination side effects.
   * Delegates storage to StreamMetaManager, then updates ephemeral state.
   */
  setTaskState(streamTabId: StreamTabId, taskState: TaskState): void {
    this._meta.setTaskState(streamTabId, taskState);
    this.clearStreamHints(streamTabId);

    const agentCategory = taskState.agentConfig.agentCategory;
    this.getOrCreateStreamState(streamTabId, agentCategory);

    this.resetFinishedChildCounters(streamTabId);
    this.cleanupToolUseAgentRegistry();
  }

  getRunOutputFiles(
    stream: StreamTabId,
    options: { storageKey: StorageKey },
  ): Map<number, OutputFileInfo[]> | undefined {
    return this._outputFiles.getRun(stream, options.storageKey);
  }

  async endRunningTaskGroups(now: number = Date.now()): Promise<StreamTabId[]> {
    const affectedFromLogs = this._streamLogs.endRunningGroups(now);
    if (affectedFromLogs.length > 0) {
      await this._streamLogs.save();
    }
    return affectedFromLogs;
  }

  // -- Lifecycle --------------------------------------------------------------

  async clearStream(stream: StreamTabId): Promise<void> {
    // Clear in-memory state
    this._outputFiles.evict(stream);
    this._usageStats.evict(stream);
    this._meta.evict(stream);
    this._runInstructions.evict(stream);
    this._sessionState.delete(stream);
    this._streamStates.delete(stream);

    if (this._prefs.get('activeStream') === stream) {
      this._prefs.update({
        activeStream: this._streamLogs.keys()[0] || '',
      });
    }

    // Delete from disk: stream log file + stream data directory
    const store = getStreamTabStore(stream);
    await Promise.all([this._streamLogs.delete(stream), store.clear()]);

    this.cleanupToolUseAgentRegistry();
  }

  async clearAll(): Promise<void> {
    this.logger.warn(
      '[Persistence] clearAll() called - this will delete all persisted data!',
      { data: { stack: new Error().stack } },
    );

    // Clear in-memory state
    this._outputFiles.evictAll();
    this._usageStats.evictAll();
    this._meta.evictAll();
    this._runInstructions.evictAll();
    this._sessionState.clear();
    this._streamStates.clear();
    this._prefs.reset();

    // Delete from disk
    await Promise.all([this._streamLogs.clear(), deleteAllStreamData()]);

    this.cleanupToolUseAgentRegistry();
  }

  async load(): Promise<void> {
    this.logger.info('[Persistence] Starting state load from storage');

    // Load stream logs first — they define the set of known streams
    await this._streamLogs.load(this.storage);

    // Discover all stream IDs from stream logs
    const streamIds = this.discoverStreamIds();

    this.logger.info(`[Persistence] Discovered ${streamIds.length} stream(s)`);

    // Check if we need one-time migration from workspace state
    const shouldMigrate = await needsMigrationFromMemento(
      this.storage,
      streamIds,
    );
    if (shouldMigrate) {
      await migrateFromMemento(
        this.storage,
        this._streamLogs.keys(),
        this.logger,
      );
      // Re-discover after migration
      const migratedIds = this.discoverStreamIds();
      await this.loadManagers(migratedIds);
    } else {
      await this.loadManagers(streamIds);
    }

    this.logger.info('[Persistence] Managers loaded');

    this.validateActiveStream();
    this.cleanupToolUseAgentRegistry();

    this.logger.info('[Persistence] State load complete');
  }

  /**
   * Flush pending writes from all managers.
   */
  async flush(): Promise<void> {
    await this._streamLogs.flush();
  }

  // -- Private helpers --------------------------------------------------------

  private async loadManagers(streamIds: StreamTabId[]): Promise<void> {
    await Promise.all([
      this._outputFiles.load(streamIds),
      this._usageStats.load(streamIds),
      this._meta.load(streamIds),
      this._runInstructions.load(streamIds),
    ]);
  }

  /** Validate activeStream against available streams after load */
  private validateActiveStream(): void {
    const savedActiveStream = this._prefs.get('activeStream');
    if (!savedActiveStream || !this._streamLogs.has(savedActiveStream)) {
      const fallback = this._streamLogs.keys()[0] ?? '';
      if (fallback !== savedActiveStream) {
        this._prefs.update({ activeStream: fallback });
      }
    }
  }

  /**
   * Discover all known stream IDs from stream logs.
   */
  private discoverStreamIds(): StreamTabId[] {
    return [...this._streamLogs.keys()];
  }

  private cleanupToolUseAgentRegistry(): void {
    cleanupInactiveAgents(this._meta.getActiveToolUseStreams());
  }
}
