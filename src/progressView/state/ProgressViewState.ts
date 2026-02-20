import { z } from 'zod';

import {
  AgentCategoryFilterSchema,
  ContextStateDataSchema,
  STREAM_STATUS,
  createStreamState,
  InstructionUpdateSchema,
  StorageKeySchema,
  StorageRecordSchema,
  StreamTabIdSchema,
  TaskGroupSchema,
  TodoItemSchema,
  type AgentCategoryFilter,
  type ContextStateData,
  type ExecutionId,
  type InstructionUpdate,
  type OutputFileInfo,
  type StorageKey,
  type StreamState,
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
import { isPlainObject } from '@shared/utils/string';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { cleanupInactiveAgents } from '@agent/toolUse/ToolUseAgentRegistry';
import { workspaceSM, WorkspaceStateKey } from '@common/state';
import { normalizeRunId } from '@common/constants/runIds';
import { AgentLogger } from '@logger/AgentLogger';
import {
  TaskState,
  TaskStateSchema,
  isToolUseTaskState,
} from '@logger/TaskState';
import { OutputFilesManager } from '@progressView/managers/OutputFilesManager';
import { StreamTabsManager } from '@progressView/managers/StreamTabsManager';
import { UsageStatsManager } from '@progressView/managers/UsageStatsManager';
import type { MementoStorage } from '@progressView/persistence/PersistentMapManager';
import { createRecordToMapSchema } from '@progressView/persistence/schemaUtils';
import { mapToRecord } from '@progressView/persistence/serializationUtils';

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
const RunInstructionsByStreamSchema = z.record(
  z.string(),
  createRecordToMapSchema(InstructionUpdateSchema),
);
const TaskGroupsByStreamSchema = z.record(
  z.string(),
  createRecordToMapSchema(TaskGroupSchema),
);

/** Core state management for the progress view. */
export class ProgressViewState {
  private _streamTabs: StreamTabsManager;
  private _taskGroups = new Map<StreamTabId, Map<string, TaskGroup>>();
  private _outputFiles: OutputFilesManager;
  private _usageStats: UsageStatsManager;
  private _runInstructions = new Map<
    StreamTabId,
    Map<string, InstructionUpdate>
  >();
  private _prefs!: PersistedState<ProgressViewPrefs>;
  private readonly taskStates = new Map<StreamTabId, TaskState>();
  private _executionIds: Map<StreamTabId, ExecutionId> = new Map();
  private _streamStates = new Map<StreamTabId, StreamState>();
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
    this._streamTabs = new StreamTabsManager(resolvedStorage);
    this._outputFiles = new OutputFilesManager(resolvedStorage);
    this._usageStats = new UsageStatsManager(resolvedStorage);
  }

  get streamTabs(): StreamTabsManager {
    return this._streamTabs;
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
   * Returns current if valid, otherwise first available, otherwise current as fallback.
   *
   * Preserves current when availableStreams is empty to avoid clearing content
   * during temporary filter mismatches.
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
    // Auto-set creationTimestamp for new streams (first call to updateStreamHints)
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
    this.saveActiveRunIds();
  }

  getActiveRunId(stream: StreamTabId): StorageKey | null {
    return this._sessionState.get(stream)?.activeRunId ?? null;
  }

  setParentStream(
    childStreamId: StreamTabId,
    parentStreamId: StreamTabId,
  ): void {
    this.getOrCreateSession(childStreamId).parentStreamId = parentStreamId;
    this.saveParentStreamIds();
  }

  getParentStreamId(streamId: StreamTabId): StreamTabId | undefined {
    return this._sessionState.get(streamId)?.parentStreamId;
  }

  getOrCreateStreamState(
    stream: StreamTabId,
    agentCategory: (typeof AgentCategory)[keyof typeof AgentCategory],
  ): StreamState {
    const existing = this._streamStates.get(stream);
    // Create new state, or replace if kind doesn't match the agent category
    if (!existing || existing.kind !== agentCategory) {
      const state = createStreamState(agentCategory);
      this._streamStates.set(stream, state);
      return state;
    }
    return existing;
  }

  updateStreamState(
    stream: StreamTabId,
    updater: (prev: StreamState) => StreamState,
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

  getStreamState(stream: StreamTabId): StreamState | undefined {
    return this._streamStates.get(stream);
  }

  getAllStreamStates(): Record<StreamTabId, StreamState> {
    return Object.fromEntries(this._streamStates.entries());
  }

  getStreamLastTimestamp(stream: StreamTabId): number | undefined {
    return (
      this._streamStates.get(stream)?.lastTimestamp ??
      this._streamTabs.getLastTimestamp(stream)
    );
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

  async setRunInstruction(
    stream: StreamTabId,
    runId: StorageKey,
    instruction: InstructionUpdate | null,
  ): Promise<void> {
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
    this.saveRunInstructions();
  }

  async deleteRunInstruction(
    stream: StreamTabId,
    runId: StorageKey,
  ): Promise<void> {
    const existing = this._runInstructions.get(stream);
    if (!existing) return;

    existing.delete(runId);
    if (existing.size === 0) {
      this._runInstructions.delete(stream);
    }
    this.saveRunInstructions();
  }

  private loadActiveRunIds(): void {
    const stored = this.loadRecord(WorkspaceStateKey.ACTIVE_RUN_IDS);

    // Restore active run IDs into consolidated ephemeral state
    for (const [stream, runId] of Object.entries(stored)) {
      if (typeof runId === 'string' && runId.length > 0) {
        this.getOrCreateSession(stream as StreamTabId).activeRunId =
          normalizeRunId(runId);
      }
    }
  }

  private saveActiveRunIds(): void {
    // Extract active run IDs from consolidated ephemeral state
    const record: Record<string, string | null> = {};
    for (const [stream, state] of this._sessionState.entries()) {
      if (state.activeRunId !== null) {
        record[stream] = state.activeRunId;
      }
    }
    void this.storage.update(WorkspaceStateKey.ACTIVE_RUN_IDS, record);
  }

  private loadParentStreamIds(): void {
    const stored = this.loadRecord(WorkspaceStateKey.PARENT_STREAM_IDS);

    for (const [stream, parentId] of Object.entries(stored)) {
      if (typeof parentId === 'string' && parentId.length > 0) {
        this.getOrCreateSession(stream as StreamTabId).parentStreamId =
          parentId as StreamTabId;
      }
    }
  }

  private saveParentStreamIds(): void {
    const record: Record<string, string> = {};
    for (const [stream, state] of this._sessionState.entries()) {
      if (state.parentStreamId) {
        record[stream] = state.parentStreamId;
      }
    }
    void this.storage.update(WorkspaceStateKey.PARENT_STREAM_IDS, record);
  }

  // Task state management
  setTaskState(streamTabId: StreamTabId, taskState: TaskState): void {
    this.taskStates.set(streamTabId, taskState);
    this.clearStreamHints(streamTabId);

    // Create or update frontend stream state with correct discriminated type
    const agentCategory = taskState.agentConfig.agentCategory;
    this.getOrCreateStreamState(streamTabId, agentCategory);

    // Reset finished child counters for the new run (they are per-run, not per-stream)
    this.resetFinishedChildCounters(streamTabId);

    this.saveTaskStates();
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

  async addTaskGroup(
    stream: StreamTabId,
    groupId: string,
    group: TaskGroup,
  ): Promise<void> {
    const streamGroups = this._taskGroups.get(stream) ?? new Map();
    streamGroups.set(groupId, { ...group });
    this._taskGroups.set(stream, streamGroups);
    await this.saveTaskGroups();
  }

  getTaskGroups(stream: StreamTabId): Map<string, TaskGroup> {
    return this._taskGroups.get(stream) ?? new Map();
  }

  async updateTaskGroup(payload: UpdateTaskGroupPayload): Promise<void> {
    const streamGroups = this._taskGroups.get(payload.streamId);
    if (!streamGroups) {
      this.logger.warn(
        `Cannot update group ${payload.id}: stream ${payload.streamId} not found`,
      );
      return;
    }

    const group = streamGroups.get(payload.id);
    if (!group) {
      this.logger.warn(
        `Cannot update group ${payload.id}: group not found in stream ${payload.streamId}`,
      );
      return;
    }

    group.status = payload.status;
    if (payload.endTime !== undefined) {
      group.endTime = payload.endTime;
    }
    await this.saveTaskGroups();
  }

  async endRunningTaskGroups(now: number = Date.now()): Promise<StreamTabId[]> {
    const affected: StreamTabId[] = [];

    for (const [streamId, groups] of this._taskGroups.entries()) {
      let count = 0;
      for (const group of groups.values()) {
        if (group.status === STREAM_STATUS.RUNNING) {
          group.status = STREAM_STATUS.ERROR;
          group.endTime = now;
          count++;
        }
      }

      if (count > 0) {
        affected.push(streamId);
        this.logger.debug(
          `Marked ${count} running task groups in stream ${streamId} as ERROR after reload`,
        );
      }
    }

    if (affected.length > 0) {
      await this.saveTaskGroups();
    }

    return affected;
  }

  setExecutionId(streamTabId: StreamTabId, executionId: ExecutionId): void {
    this._executionIds.set(streamTabId, executionId);
    this.saveExecutionIds();
  }

  getExecutionId(streamTabId: StreamTabId): ExecutionId | undefined {
    return this._executionIds.get(streamTabId);
  }

  async clearStream(stream: StreamTabId): Promise<void> {
    this._taskGroups.delete(stream);
    await Promise.all([
      this._streamTabs.delete(stream),
      this.saveTaskGroups(),
      this._outputFiles.deleteStream(stream),
      this._usageStats.delete(stream),
    ]);

    const removedState = this.taskStates.delete(stream);
    this._executionIds.delete(stream);
    this._sessionState.delete(stream);
    this._streamStates.delete(stream);
    this._runInstructions.delete(stream);

    if (this._prefs.get('activeStream') === stream) {
      this._prefs.update({
        activeStream: this._streamTabs.keys()[0] || '',
      });
    }

    if (removedState) {
      this.saveTaskStates();
      this.cleanupToolUseAgentRegistry();
    }
    this.saveExecutionIds();
    this.saveActiveRunIds();
    this.saveParentStreamIds();
    this.saveRunInstructions();
  }

  async clearAll(): Promise<void> {
    this.logger.warn(
      '[Persistence] clearAll() called - this will delete all persisted data!',
      { data: { stack: new Error().stack } },
    );

    this._taskGroups.clear();
    await Promise.all([
      this._streamTabs.clear(),
      this.saveTaskGroups(),
      this._outputFiles.clear(),
      this._usageStats.clear(),
    ]);
    this.taskStates.clear();
    this._executionIds.clear();
    this._sessionState.clear();
    this._streamStates.clear();
    this._runInstructions.clear();
    this._prefs.reset();
    this.saveTaskStates();
    this.saveExecutionIds();
    this.saveActiveRunIds();
    this.saveParentStreamIds();
    this.saveRunInstructions();
    this.cleanupToolUseAgentRegistry();
  }

  async load(): Promise<void> {
    this.logger.info(
      '[Persistence] Starting state load from workspace storage',
    );

    await Promise.all([
      this._streamTabs.load(),
      this.loadTaskGroups(),
      this._outputFiles.load(),
      this._usageStats.load(),
    ]);

    this.logger.info('[Persistence] Managers loaded');

    // Prefs loaded automatically via PersistedState constructor
    this.validateActiveStream();
    this.loadTaskStates();
    this.loadExecutionIds();
    this.loadRunInstructions();
    this.loadActiveRunIds();
    this.loadParentStreamIds();

    this.logger.info(
      `[Persistence] State load complete - taskStates: ${this.taskStates.size}, executionIds: ${this._executionIds.size}`,
    );
  }

  /**
   * Flush pending writes from all managers.
   * Only StreamTabsManager has debounced writes; the rest are no-ops.
   */
  async flush(): Promise<void> {
    await this._streamTabs.flush();
  }

  /** Validate activeStream against available streams after load */
  private validateActiveStream(): void {
    const savedActiveStream = this._prefs.get('activeStream');
    if (!savedActiveStream || !this._streamTabs.has(savedActiveStream)) {
      const fallback = this._streamTabs.keys()[0] ?? '';
      if (fallback !== savedActiveStream) {
        this._prefs.update({ activeStream: fallback });
      }
    }
  }

  private loadTaskStates(): void {
    const raw = this.loadRecord(WorkspaceStateKey.TASK_STATES);
    this.taskStates.clear();

    const rawKeys = Object.keys(raw);
    this.logger.info(
      `[Persistence] Loading task states - found ${rawKeys.length} keys: ${rawKeys.slice(0, 5).join(', ')}${rawKeys.length > 5 ? '...' : ''}`,
    );

    if (rawKeys.length === 0) {
      this.logger.info('[Persistence] No task states found in storage');
      this.cleanupToolUseAgentRegistry();
      return;
    }

    // Collect entries from legacy format (workflow/toolUse sub-objects) or flat format
    const entries = this.extractTaskStateEntries(raw);
    this.logger.info(
      `[Persistence] Extracted ${entries.length} task state entries (legacy format: ${rawKeys.includes('workflow') || rawKeys.includes('toolUse')})`,
    );

    let loaded = 0;
    let skipped = 0;
    for (const [stream, rawState] of entries) {
      const parseResult = TaskStateSchema.safeParse(rawState);
      if (!parseResult.success) {
        this.logger.warn(
          `[Persistence] Skipping invalid task state for stream ${stream}: ${parseResult.error.message}`,
        );
        skipped += 1;
        continue;
      }

      this.taskStates.set(stream as StreamTabId, parseResult.data as TaskState);
      loaded += 1;
    }

    this.logger.info(
      `[Persistence] Task states loaded: ${loaded} successful, ${skipped} skipped`,
    );

    this.cleanupToolUseAgentRegistry();
  }

  private extractTaskStateEntries(
    raw: Record<string, unknown>,
  ): [string, unknown][] {
    const legacyBuckets = [raw.workflow, raw.toolUse].filter(isPlainObject);
    if (legacyBuckets.length > 0) {
      return legacyBuckets.flatMap((bucket) =>
        Object.entries(bucket).filter(([, v]) => isPlainObject(v)),
      );
    }

    return Object.entries(raw).filter(([, v]) => isPlainObject(v));
  }

  private loadExecutionIds(): void {
    const savedIdsRecord = this.loadRecord(WorkspaceStateKey.EXECUTION_IDS);

    const entries = Object.entries(savedIdsRecord).filter(
      (entry): entry is [StreamTabId, ExecutionId] =>
        typeof entry[1] === 'string' && entry[1].length > 0,
    );

    this._executionIds = new Map(entries);
    if (entries.length > 0) {
      this.logger.debug(`Loaded execution IDs for ${entries.length} streams`);
    }
  }

  private loadRunInstructions(): void {
    const stored = this.loadRecord(WorkspaceStateKey.RUN_INSTRUCTIONS);
    const parsed = RunInstructionsByStreamSchema.parse(stored);
    this._runInstructions = new Map(
      Object.entries(parsed).map(([stream, instructions]) => [
        stream as StreamTabId,
        instructions,
      ]),
    );
  }

  private async loadTaskGroups(): Promise<void> {
    const stored = this.loadRecord(WorkspaceStateKey.TASK_GROUPS);
    const parsed = TaskGroupsByStreamSchema.parse(stored);
    this._taskGroups = new Map(
      Object.entries(parsed).map(([stream, groups]) => [
        stream as StreamTabId,
        groups,
      ]),
    );
  }

  private async saveTaskGroups(): Promise<void> {
    const record: Record<string, unknown> = {};
    for (const [stream, groups] of this._taskGroups.entries()) {
      record[stream] = mapToRecord(groups);
    }
    await this.storage.update(WorkspaceStateKey.TASK_GROUPS, record);
  }

  private loadRecord(key: WorkspaceStateKey): Record<string, unknown> {
    return StorageRecordSchema.parse(this.storage.get(key));
  }

  private saveTaskStates(): void {
    const serialized = Object.fromEntries(this.taskStates);
    void this.storage.update(WorkspaceStateKey.TASK_STATES, serialized);
  }

  private cleanupToolUseAgentRegistry(): void {
    const activeStreams = new Set<StreamTabId>();
    for (const [stream, state] of this.taskStates) {
      if (isToolUseTaskState(state)) activeStreams.add(stream);
    }
    cleanupInactiveAgents(activeStreams);
  }

  private saveExecutionIds(): void {
    const executionIdsObj = mapToRecord(this._executionIds);
    void this.storage.update(WorkspaceStateKey.EXECUTION_IDS, executionIdsObj);
  }

  private saveRunInstructions(): void {
    const serialized: Record<string, Record<string, InstructionUpdate>> = {};
    for (const [stream, instructions] of this._runInstructions.entries()) {
      if (instructions.size === 0) continue;
      serialized[stream] = mapToRecord(instructions);
    }
    void this.storage.update(WorkspaceStateKey.RUN_INSTRUCTIONS, serialized);
  }
}
