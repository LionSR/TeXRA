import { z } from 'zod';

import {
  AgentCategoryFilterSchema,
  ContextStateDataSchema,
  StorageKeySchema,
  StorageRecordSchema,
  StreamTabIdSchema,
  TaskGroupSchema,
  TodoItemSchema,
  type ActiveChildInfo,
  type AgentCategoryFilter,
  type ConversationProgress,
  type ContextStateData,
  type ExecutionId,
  type InstructionUpdate,
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
import { normalizeRunId } from '@common/constants/runIds';
import { AgentLogger } from '@logger/AgentLogger';
import { StreamLogStore } from '@logger/StreamLogStore';
import {
  TaskState,
  TaskStateSchema,
  isToolUseTaskState,
} from '@logger/TaskState';
import { OutputFilesManager } from '@progressView/managers/OutputFilesManager';
import { UsageStatsManager } from '@progressView/managers/UsageStatsManager';
import type { MementoStorage } from '@progressView/persistence/PersistentMapManager';
import { mapToRecord } from '@progressView/persistence/serializationUtils';
import {
  getStreamTabStore,
  deleteAllStreamData,
  STREAM_DATA_DIR,
} from '@progressView/persistence/StreamTabStore';
import { type StreamTabMeta } from '@progressView/persistence/streamTabSchemas';
import { KVStore } from '@common/storage';

/** Ephemeral stream metadata hints, displayed before TaskState is fully populated. */
export const StreamHintsSchema = z.object({
  agentCategory: z.enum(AgentCategory).optional(),
  isRemote: z.boolean().optional(),
  hasMultipleOutputs: z.boolean().optional(),
  creationTimestamp: z.number().optional(),
});

export type StreamHints = z.infer<typeof StreamHintsSchema>;

/** Consolidated session state per stream. Schema provides defaults via .prefault(). */
export const StreamSessionStateSchema = z.object({
  hints: StreamHintsSchema.prefault({}),
  todos: z.array(TodoItemSchema).prefault([]),
  contextState: ContextStateDataSchema.nullable().prefault(null),
  activeRunId: StorageKeySchema.nullable().prefault(null),
  parentStreamId: StreamTabIdSchema.optional(),
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

/** Core state management for the progress view. */
export class ProgressViewState {
  private _streamLogs: StreamLogStore;
  private _outputFiles: OutputFilesManager;
  private _usageStats: UsageStatsManager;
  private _runInstructions = new Map<
    StreamTabId,
    Map<string, InstructionUpdate>
  >();
  private _prefs!: PersistedState<ProgressViewPrefs>;
  private readonly taskStates = new Map<StreamTabId, TaskState>();
  private _executionIds: Map<StreamTabId, ExecutionId> = new Map();
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
  }

  get streamLogs(): StreamLogStore {
    return this._streamLogs;
  }

  get outputFiles(): OutputFilesManager {
    return this._outputFiles;
  }

  get usageStats(): UsageStatsManager {
    return this._usageStats;
  }

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

  setActiveRunId(stream: StreamTabId, runId: string | null): void {
    const storageKey = runId ? normalizeRunId(runId) : null;
    this.getOrCreateSession(stream).activeRunId = storageKey;
    this.saveStreamMeta(stream);
  }

  getActiveRunId(stream: StreamTabId): StorageKey | null {
    return this._sessionState.get(stream)?.activeRunId ?? null;
  }

  setParentStream(
    childStreamId: StreamTabId,
    parentStreamId: StreamTabId,
  ): void {
    this.getOrCreateSession(childStreamId).parentStreamId = parentStreamId;
    this.saveStreamMeta(childStreamId);
  }

  getParentStreamId(streamId: StreamTabId): StreamTabId | undefined {
    return this._sessionState.get(streamId)?.parentStreamId;
  }

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

  getRunInstructions(stream: StreamTabId): Map<string, InstructionUpdate> {
    return new Map(this._runInstructions.get(stream) ?? []);
  }

  getRunInstruction(
    stream: StreamTabId,
    runId: StorageKey,
  ): InstructionUpdate | undefined {
    return this._runInstructions.get(stream)?.get(runId);
  }

  setRunInstruction(
    stream: StreamTabId,
    runId: StorageKey,
    instruction: InstructionUpdate | null,
  ): void {
    const existing = this._runInstructions.get(stream) ?? new Map();
    if (instruction) {
      existing.set(runId, instruction);
      this._runInstructions.set(stream, existing);
    } else {
      existing.delete(runId);
      if (existing.size === 0) {
        this._runInstructions.delete(stream);
      } else {
        this._runInstructions.set(stream, existing);
      }
    }
    this.saveRunInstructions(stream);
  }

  // Task state management
  setTaskState(streamTabId: StreamTabId, taskState: TaskState): void {
    this.taskStates.set(streamTabId, taskState);
    this.clearStreamHints(streamTabId);

    const agentCategory = taskState.agentConfig.agentCategory;
    this.getOrCreateStreamState(streamTabId, agentCategory);

    this.resetFinishedChildCounters(streamTabId);

    this.saveStreamMeta(streamTabId);
    this.cleanupToolUseAgentRegistry();
  }

  getTaskState(streamTabId: StreamTabId): TaskState | undefined {
    return this.taskStates.get(streamTabId);
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

  setExecutionId(streamTabId: StreamTabId, executionId: ExecutionId): void {
    this._executionIds.set(streamTabId, executionId);
    this.saveStreamMeta(streamTabId);
  }

  getExecutionId(streamTabId: StreamTabId): ExecutionId | undefined {
    return this._executionIds.get(streamTabId);
  }

  async clearStream(stream: StreamTabId): Promise<void> {
    // Clear in-memory state
    this._outputFiles.evict(stream);
    this._usageStats.evict(stream);
    const removedState = this.taskStates.delete(stream);
    this._executionIds.delete(stream);
    this._sessionState.delete(stream);
    this._streamStates.delete(stream);
    this._runInstructions.delete(stream);

    if (this._prefs.get('activeStream') === stream) {
      this._prefs.update({
        activeStream: this._streamLogs.keys()[0] || '',
      });
    }

    // Delete from disk: stream log file + stream data directory
    const store = getStreamTabStore(stream);
    await Promise.all([
      this._streamLogs.delete(stream),
      store.clear(),
    ]);

    if (removedState) {
      this.cleanupToolUseAgentRegistry();
    }
  }

  async clearAll(): Promise<void> {
    this.logger.warn(
      '[Persistence] clearAll() called - this will delete all persisted data!',
      { data: { stack: new Error().stack } },
    );

    // Clear in-memory state
    this._outputFiles.evictAll();
    this._usageStats.evictAll();
    this.taskStates.clear();
    this._executionIds.clear();
    this._sessionState.clear();
    this._streamStates.clear();
    this._runInstructions.clear();
    this._prefs.reset();

    // Delete from disk
    await Promise.all([
      this._streamLogs.clear(),
      deleteAllStreamData(),
    ]);

    this.cleanupToolUseAgentRegistry();
  }

  async load(): Promise<void> {
    this.logger.info(
      '[Persistence] Starting state load from storage',
    );

    // Load stream logs first — they define the set of known streams
    await this._streamLogs.load(this.storage);

    // Discover all stream IDs from disk + stream logs
    const streamIds = await this.discoverStreamIds();

    this.logger.info(
      `[Persistence] Discovered ${streamIds.length} stream(s)`,
    );

    // Check if we need one-time migration from workspace state
    const needsMigration = await this.needsMigrationFromMemento(streamIds);
    if (needsMigration) {
      await this.migrateFromMemento();
      // Re-discover after migration
      const migratedIds = await this.discoverStreamIds();
      await Promise.all([
        this._outputFiles.load(migratedIds),
        this._usageStats.load(migratedIds),
      ]);
      this.loadMetaFromDisk(migratedIds);
    } else {
      // Normal load from disk
      await Promise.all([
        this._outputFiles.load(streamIds),
        this._usageStats.load(streamIds),
      ]);
      await this.loadMetaFromDisk(streamIds);
    }

    this.logger.info('[Persistence] Managers loaded');

    this.validateActiveStream();

    this.logger.info(
      `[Persistence] State load complete - taskStates: ${this.taskStates.size}, executionIds: ${this._executionIds.size}`,
    );
  }

  /**
   * Flush pending writes from all managers.
   */
  async flush(): Promise<void> {
    await this._streamLogs.flush();
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
   * Discover all known stream IDs from both disk and stream logs.
   */
  private async discoverStreamIds(): Promise<StreamTabId[]> {
    const kv = new KVStore(STREAM_DATA_DIR);
    // listKeys returns directory names (stream tab IDs) from the streamData dir
    // But KVStore.listKeys only finds .json files, not subdirectories.
    // We need to check stream logs as the canonical source, plus any on-disk streams.
    const logStreams = new Set(this._streamLogs.keys());

    // Try to discover on-disk streams by checking for meta.json files
    // We rely on stream logs as the source of truth for known streams
    return [...logStreams] as StreamTabId[];
  }

  /**
   * Check if we need one-time migration from workspace state to disk.
   * Returns true if workspace state has data but disk has no stream data.
   */
  private async needsMigrationFromMemento(
    streamIds: StreamTabId[],
  ): Promise<boolean> {
    // If we already have data on disk for any stream, skip migration
    if (streamIds.length > 0) {
      const store = getStreamTabStore(streamIds[0]);
      const meta = await store.readMeta();
      if (meta) return false;
    }

    // Check if memento has any of the legacy keys with data
    const legacyKeys = [
      WorkspaceStateKey.TASK_STATES,
      WorkspaceStateKey.OUTPUT_FILES,
      WorkspaceStateKey.USAGE_STATS,
      WorkspaceStateKey.EXECUTION_IDS,
      WorkspaceStateKey.ACTIVE_RUN_IDS,
      WorkspaceStateKey.PARENT_STREAM_IDS,
      WorkspaceStateKey.RUN_INSTRUCTIONS,
      WorkspaceStateKey.MISSING_OUTPUTS,
    ] as const;

    for (const key of legacyKeys) {
      const raw = this.storage.get(key);
      if (raw && typeof raw === 'object' && Object.keys(raw as object).length > 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * One-time migration from workspace state (VS Code memento) to disk-backed storage.
   * Migrates all per-stream data to StreamTabStore, then clears the legacy keys.
   */
  private async migrateFromMemento(): Promise<void> {
    this.logger.info('[Migration] Starting one-time migration from workspace state to disk');

    // Load all legacy data from memento
    const taskStatesRaw = this.loadRecord(WorkspaceStateKey.TASK_STATES);
    const executionIdsRaw = this.loadRecord(WorkspaceStateKey.EXECUTION_IDS);
    const activeRunIdsRaw = this.loadRecord(WorkspaceStateKey.ACTIVE_RUN_IDS);
    const parentStreamIdsRaw = this.loadRecord(WorkspaceStateKey.PARENT_STREAM_IDS);
    const runInstructionsRaw = this.loadRecord(WorkspaceStateKey.RUN_INSTRUCTIONS);
    const outputFilesRaw = this.loadRecord(WorkspaceStateKey.OUTPUT_FILES);
    const missingOutputsRaw = this.loadRecord(WorkspaceStateKey.MISSING_OUTPUTS);
    const usageStatsRaw = this.loadRecord(WorkspaceStateKey.USAGE_STATS);

    // Collect all known stream IDs from all sources
    const allStreamIds = new Set<StreamTabId>();
    for (const record of [
      taskStatesRaw,
      executionIdsRaw,
      activeRunIdsRaw,
      parentStreamIdsRaw,
      runInstructionsRaw,
      outputFilesRaw,
      missingOutputsRaw,
      usageStatsRaw,
    ]) {
      for (const key of Object.keys(record)) {
        // Skip legacy bucket keys
        if (key === 'workflow' || key === 'toolUse') {
          const bucket = record[key];
          if (typeof bucket === 'object' && bucket !== null) {
            for (const innerKey of Object.keys(bucket as Record<string, unknown>)) {
              allStreamIds.add(innerKey as StreamTabId);
            }
          }
        } else {
          allStreamIds.add(key as StreamTabId);
        }
      }
    }
    // Also include stream log keys
    for (const key of this._streamLogs.keys()) {
      allStreamIds.add(key);
    }

    this.logger.info(
      `[Migration] Found ${allStreamIds.size} stream(s) to migrate`,
    );

    // Extract task state entries (handles legacy workflow/toolUse format)
    const taskStateEntries = this.extractTaskStateEntries(taskStatesRaw);

    // Migrate each stream's data to disk
    const writes: Promise<void>[] = [];
    for (const streamId of allStreamIds) {
      writes.push(
        this.migrateStreamToStore(streamId, {
          taskStateEntries,
          executionIdsRaw,
          activeRunIdsRaw,
          parentStreamIdsRaw,
          runInstructionsRaw,
          outputFilesRaw,
          missingOutputsRaw,
          usageStatsRaw,
        }),
      );
    }
    await Promise.all(writes);

    // Clear legacy workspace state keys
    this.logger.info('[Migration] Clearing legacy workspace state keys');
    await Promise.all([
      this.storage.update(WorkspaceStateKey.TASK_STATES, undefined as never),
      this.storage.update(WorkspaceStateKey.EXECUTION_IDS, undefined as never),
      this.storage.update(WorkspaceStateKey.ACTIVE_RUN_IDS, undefined as never),
      this.storage.update(WorkspaceStateKey.PARENT_STREAM_IDS, undefined as never),
      this.storage.update(WorkspaceStateKey.RUN_INSTRUCTIONS, undefined as never),
      this.storage.update(WorkspaceStateKey.OUTPUT_FILES, undefined as never),
      this.storage.update(WorkspaceStateKey.MISSING_OUTPUTS, undefined as never),
      this.storage.update(WorkspaceStateKey.USAGE_STATS, undefined as never),
    ]);

    this.logger.info('[Migration] Migration complete');
  }

  private async migrateStreamToStore(
    streamId: StreamTabId,
    data: {
      taskStateEntries: [string, unknown][];
      executionIdsRaw: Record<string, unknown>;
      activeRunIdsRaw: Record<string, unknown>;
      parentStreamIdsRaw: Record<string, unknown>;
      runInstructionsRaw: Record<string, unknown>;
      outputFilesRaw: Record<string, unknown>;
      missingOutputsRaw: Record<string, unknown>;
      usageStatsRaw: Record<string, unknown>;
    },
  ): Promise<void> {
    const store = getStreamTabStore(streamId);
    const writes: Promise<void>[] = [];

    // Meta: taskState + executionId + activeRunId + parentStreamId
    const taskStateEntry = data.taskStateEntries.find(
      ([key]) => key === streamId,
    );
    const taskState = taskStateEntry
      ? TaskStateSchema.safeParse(taskStateEntry[1])
      : null;
    const executionId = data.executionIdsRaw[streamId];
    const activeRunId = data.activeRunIdsRaw[streamId];
    const parentStreamId = data.parentStreamIdsRaw[streamId];

    const meta: StreamTabMeta = {};
    if (taskState?.success) {
      meta.taskState = taskState.data as TaskState;
    }
    if (typeof executionId === 'string' && executionId.length > 0) {
      meta.executionId = executionId;
    }
    if (typeof activeRunId === 'string' && activeRunId.length > 0) {
      meta.activeRunId = activeRunId;
    }
    if (typeof parentStreamId === 'string' && parentStreamId.length > 0) {
      meta.parentStreamId = parentStreamId;
    }
    if (Object.keys(meta).length > 0) {
      writes.push(store.writeMeta(meta));
    }

    // Output files
    const outputFilesData = data.outputFilesRaw[streamId];
    if (outputFilesData && typeof outputFilesData === 'object') {
      writes.push(
        store.writeOutputFiles(
          outputFilesData as Record<string, Record<string, OutputFileInfo[]>>,
        ),
      );
    }

    // Missing outputs
    const missingOutputsData = data.missingOutputsRaw[streamId];
    if (missingOutputsData && typeof missingOutputsData === 'object') {
      writes.push(
        store.writeMissingOutputs(
          missingOutputsData as Record<string, Record<string, string[]>>,
        ),
      );
    }

    // Usage stats — normalize legacy single-value format to run-map format
    const usageStatsData = data.usageStatsRaw[streamId];
    if (usageStatsData && typeof usageStatsData === 'object') {
      const raw = usageStatsData as Record<string, unknown>;
      // Legacy format: bare { inputTokens, outputTokens, cost } without run wrapper
      const isLegacy = 'inputTokens' in raw || 'outputTokens' in raw || 'cost' in raw;
      const normalized = isLegacy
        ? { default: raw }
        : raw;
      writes.push(
        store.writeUsageStats(
          normalized as Record<string, import('@shared/schemas').TokenUsageStats>,
        ),
      );
    }

    // Run instructions
    const runInstructionsData = data.runInstructionsRaw[streamId];
    if (runInstructionsData && typeof runInstructionsData === 'object') {
      writes.push(
        store.writeRunInstructions(
          runInstructionsData as Record<string, InstructionUpdate>,
        ),
      );
    }

    await Promise.all(writes);
  }

  /**
   * Load meta.json + runInstructions from disk for all known streams.
   * Populates taskStates, executionIds, sessionState, and runInstructions.
   */
  private async loadMetaFromDisk(streamIds: StreamTabId[]): Promise<void> {
    this.taskStates.clear();
    this._executionIds.clear();
    this._runInstructions.clear();

    const results = await Promise.all(
      streamIds.map(async (streamId) => {
        const store = getStreamTabStore(streamId);
        const [meta, runInstructions] = await Promise.all([
          store.readMeta(),
          store.readRunInstructions(),
        ]);
        return { streamId, meta, runInstructions };
      }),
    );

    let loadedTasks = 0;
    let skippedTasks = 0;

    for (const { streamId, meta, runInstructions } of results) {
      if (meta) {
        // Task state
        if (meta.taskState) {
          const parseResult = TaskStateSchema.safeParse(meta.taskState);
          if (parseResult.success) {
            this.taskStates.set(streamId, parseResult.data as TaskState);
            loadedTasks++;
          } else {
            this.logger.warn(
              `[Persistence] Skipping invalid task state for stream ${streamId}: ${parseResult.error.message}`,
            );
            skippedTasks++;
          }
        }

        // Execution ID
        if (meta.executionId) {
          this._executionIds.set(
            streamId,
            meta.executionId as ExecutionId,
          );
        }

        // Active run ID
        if (meta.activeRunId) {
          this.getOrCreateSession(streamId).activeRunId = normalizeRunId(
            meta.activeRunId,
          );
        }

        // Parent stream ID
        if (meta.parentStreamId) {
          this.getOrCreateSession(streamId).parentStreamId =
            meta.parentStreamId as StreamTabId;
        }
      }

      // Run instructions
      if (runInstructions && runInstructions.size > 0) {
        this._runInstructions.set(streamId, runInstructions);
      }
    }

    this.logger.info(
      `[Persistence] Meta loaded: ${loadedTasks} task states, ${skippedTasks} skipped, ${this._executionIds.size} execution IDs`,
    );

    this.cleanupToolUseAgentRegistry();
  }

  private extractTaskStateEntries(
    raw: Record<string, unknown>,
  ): [string, unknown][] {
    const isPlainObject = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null && !Array.isArray(v);

    const legacyBuckets = [raw.workflow, raw.toolUse].filter(isPlainObject);
    if (legacyBuckets.length > 0) {
      return legacyBuckets.flatMap((bucket) =>
        Object.entries(bucket).filter(([, v]) => isPlainObject(v)),
      );
    }

    return Object.entries(raw).filter(([, v]) => isPlainObject(v));
  }

  private loadRecord(key: WorkspaceStateKey): Record<string, unknown> {
    return StorageRecordSchema.parse(this.storage.get(key));
  }

  private cleanupToolUseAgentRegistry(): void {
    const activeStreams = new Set<StreamTabId>();
    for (const [stream, state] of this.taskStates) {
      if (isToolUseTaskState(state)) activeStreams.add(stream);
    }
    cleanupInactiveAgents(activeStreams);
  }

  // -- Per-stream meta persistence -------------------------------------------

  private saveStreamMeta(stream: StreamTabId): void {
    const meta = this.buildStreamMeta(stream);
    const store = getStreamTabStore(stream);
    void store.writeMeta(meta);
  }

  private buildStreamMeta(stream: StreamTabId): StreamTabMeta {
    const meta: StreamTabMeta = {};
    const taskState = this.taskStates.get(stream);
    if (taskState) {
      meta.taskState = taskState;
    }
    const executionId = this._executionIds.get(stream);
    if (executionId) {
      meta.executionId = executionId;
    }
    const session = this._sessionState.get(stream);
    if (session) {
      if (session.activeRunId !== null) {
        meta.activeRunId = session.activeRunId;
      }
      if (session.parentStreamId) {
        meta.parentStreamId = session.parentStreamId;
      }
    }
    return meta;
  }

  // -- Per-stream run instructions persistence --------------------------------

  private saveRunInstructions(stream: StreamTabId): void {
    const instructions = this._runInstructions.get(stream);
    const store = getStreamTabStore(stream);
    if (!instructions || instructions.size === 0) {
      void store.writeRunInstructions({});
    } else {
      void store.writeRunInstructions(mapToRecord(instructions));
    }
  }
}
