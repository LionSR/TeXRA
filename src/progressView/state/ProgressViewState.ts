import { z } from 'zod';

import {
  AgentCategoryFilterSchema,
  ContextStateDataSchema,
  createStreamState,
  StorageKeySchema,
  TodoItemSchema,
  type AgentCategoryFilter,
  type ContextStateData,
  type ExecutionId,
  type InstructionUpdate,
  type OutputFileInfo,
  type StorageKey,
  type StreamState,
  type StreamTabId,
  type TodoItem,
} from '@shared/schemas';
import { isPlainObject } from '@shared/utils/string';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { cleanupInactiveAgents } from '@agent/toolUse/ToolUseAgentRegistry';
import { normalizeRunId } from '@common/constants/runIds';
import { workspaceSM, WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import {
  TaskState,
  TaskStateSchema,
  isToolUseTaskState,
} from '@logger/TaskState';
import { OutputFilesManager } from '@progressView/managers/OutputFilesManager';
import { RunInstructionManager } from '@progressView/managers/RunInstructionManager';
import { StreamTabsManager } from '@progressView/managers/StreamTabsManager';
import { TaskGroupManager } from '@progressView/managers/TaskGroupManager';
import { UsageStatsManager } from '@progressView/managers/UsageStatsManager';
import type { StateStorage } from '@progressView/persistence/PersistentMapManager';
import { mapToRecord } from '@progressView/persistence/serializationUtils';
import { getConfig } from '@utils/config';

/** Ephemeral stream metadata hints, displayed before TaskState is fully populated. */
export const StreamHintsSchema = z.object({
  agentCategory: z.enum(AgentCategory).optional(),
  isRemote: z.boolean().optional(),
  hasMultipleOutputs: z.boolean().optional(),
});

export type StreamHints = z.infer<typeof StreamHintsSchema>;

/** Consolidated session state per stream. Schema provides defaults via .prefault(). */
export const StreamSessionStateSchema = z.object({
  hints: StreamHintsSchema.prefault({}),
  todos: z.array(TodoItemSchema).prefault([]),
  contextState: ContextStateDataSchema.nullable().prefault(null),
  activeRunId: StorageKeySchema.nullable().prefault(null),
});

type StreamSessionState = z.output<typeof StreamSessionStateSchema>;

/** Active stream identifier, or empty string when no stream is selected. */
export type ActiveStreamId = StreamTabId | '';

const PROGRESS_VIEW_DEFAULTS = {
  activeStream: '' as ActiveStreamId,
  streamSortOrder: 'time',
  agentCategoryFilter: 'all' as AgentCategoryFilter,
} as const;

/** Core state management for the progress view. */
export class ProgressViewState {
  private _streamTabs: StreamTabsManager;
  private _taskGroups: TaskGroupManager;
  private _outputFiles: OutputFilesManager;
  private _usageStats: UsageStatsManager;
  private _runInstructions: RunInstructionManager;
  private _activeStream: ActiveStreamId = PROGRESS_VIEW_DEFAULTS.activeStream;
  private _streamSortOrder: string = PROGRESS_VIEW_DEFAULTS.streamSortOrder;
  private _agentCategoryFilter: AgentCategoryFilter =
    PROGRESS_VIEW_DEFAULTS.agentCategoryFilter;
  private readonly taskStates = new Map<StreamTabId, TaskState>();
  private _executionIds: Map<StreamTabId, ExecutionId> = new Map();
  private _streamStates = new Map<StreamTabId, StreamState>();
  private _sessionState = new Map<StreamTabId, StreamSessionState>();

  private readonly storage: StateStorage;
  private readonly logger: AgentLogger;

  constructor(storage?: StateStorage) {
    const resolvedStorage = storage ?? workspaceSM;
    if (!resolvedStorage) {
      throw new Error('workspace state manager is not initialized');
    }

    this.storage = resolvedStorage;
    this.logger = new AgentLogger('ProgressViewState');
    this._streamTabs = new StreamTabsManager(resolvedStorage);
    this._taskGroups = new TaskGroupManager(resolvedStorage);
    this._outputFiles = new OutputFilesManager(resolvedStorage);
    this._usageStats = new UsageStatsManager(resolvedStorage);
    this._runInstructions = new RunInstructionManager(resolvedStorage);
  }

  get streamTabs(): StreamTabsManager {
    return this._streamTabs;
  }

  get taskGroups(): TaskGroupManager {
    return this._taskGroups;
  }

  get outputFiles(): OutputFilesManager {
    return this._outputFiles;
  }

  get usageStats(): UsageStatsManager {
    return this._usageStats;
  }

  get activeStream(): ActiveStreamId {
    return this._activeStream;
  }

  set activeStream(stream: ActiveStreamId) {
    this._activeStream = stream;
    this.saveActiveStream();
  }

  /**
   * Ensure the active stream is valid within the given set of available streams.
   * If current active stream is not available, picks the first available one.
   * Preserves current when availableStreams is empty to avoid clearing content
   * during temporary filter mismatches.
   */
  resolveActiveStream(availableStreams: StreamTabId[]): StreamTabId {
    const currentActive = this._activeStream;

    if (availableStreams.includes(currentActive)) {
      return currentActive;
    }

    const resolved = availableStreams[0];

    if (resolved && resolved !== currentActive) {
      this._activeStream = resolved;
      this.saveActiveStream();
    }

    return resolved || currentActive;
  }

  get streamSortOrder(): string {
    return this._streamSortOrder;
  }

  set streamSortOrder(order: string) {
    this._streamSortOrder = order;
    this.saveStreamSortOrder();
  }

  get agentCategoryFilter(): AgentCategoryFilter {
    return this._agentCategoryFilter;
  }

  set agentCategoryFilter(filter: AgentCategoryFilter) {
    if (!AgentCategoryFilterSchema.safeParse(filter).success) {
      this.logger.warn(
        `Invalid agent filter: ${filter}, defaulting to '${PROGRESS_VIEW_DEFAULTS.agentCategoryFilter}'`,
      );
      filter = PROGRESS_VIEW_DEFAULTS.agentCategoryFilter;
    }
    this._agentCategoryFilter = filter;
    this.saveAgentCategoryFilter();
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
    state.hints = StreamHintsSchema.parse({ ...state.hints, ...hints });
  }

  getStreamHints(streamTabId: StreamTabId): StreamHints {
    return this._sessionState.get(streamTabId)?.hints ?? {};
  }

  clearStreamHints(streamTabId: StreamTabId): void {
    this.clearSessionField(streamTabId, 'hints', {});
  }

  setTodos(stream: StreamTabId, todos: TodoItem[]): void {
    this.getOrCreateSession(stream).todos = todos;
  }

  getTodos(stream: StreamTabId): TodoItem[] | undefined {
    const todos = this._sessionState.get(stream)?.todos;
    return todos?.length ? todos : undefined;
  }

  clearTodos(stream: StreamTabId): void {
    this.clearSessionField(stream, 'todos', []);
  }

  clearAllTodos(): void {
    for (const state of this._sessionState.values()) {
      state.todos = [];
    }
  }

  setContextState(stream: StreamTabId, contextState: ContextStateData): void {
    this.getOrCreateSession(stream).contextState = contextState;
  }

  getContextState(stream: StreamTabId): ContextStateData | undefined {
    return this._sessionState.get(stream)?.contextState ?? undefined;
  }

  clearContextState(stream: StreamTabId): void {
    this.clearSessionField(stream, 'contextState', null);
  }

  private clearSessionField<K extends keyof StreamSessionState>(
    stream: StreamTabId,
    field: K,
    emptyValue: StreamSessionState[K],
  ): void {
    const state = this._sessionState.get(stream);
    if (state) {
      state[field] = emptyValue;
    }
  }

  setActiveRunId(stream: StreamTabId, runId: string | null): void {
    const storageKey = runId ? normalizeRunId(runId) : null;
    this.getOrCreateSession(stream).activeRunId = storageKey;
    this.saveActiveRunIds();
  }

  getActiveRunId(stream: StreamTabId): StorageKey | null {
    return this._sessionState.get(stream)?.activeRunId ?? null;
  }

  clearActiveRun(stream: StreamTabId): void {
    const state = this._sessionState.get(stream);
    if (state && state.activeRunId !== null) {
      state.activeRunId = null;
      this.saveActiveRunIds();
    }
  }

  getStreamState(stream: StreamTabId): StreamState | undefined {
    return this._streamStates.get(stream);
  }

  getOrCreateStreamState(
    stream: StreamTabId,
    agentCategory: (typeof AgentCategory)[keyof typeof AgentCategory],
  ): StreamState {
    let state = this._streamStates.get(stream);
    if (!state) {
      state = createStreamState(agentCategory);
      this._streamStates.set(stream, state);
    }
    return state;
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

  getAllStreamStates(): Record<StreamTabId, StreamState> {
    return Object.fromEntries(this._streamStates.entries());
  }

  clearStreamState(stream: StreamTabId): void {
    this._streamStates.delete(stream);
  }

  getRunInstructions(stream: StreamTabId): Map<string, InstructionUpdate> {
    return this._runInstructions.getInstructions(stream);
  }

  getRunInstruction(
    stream: StreamTabId,
    runId: StorageKey,
  ): InstructionUpdate | undefined {
    return this._runInstructions.getInstructions(stream).get(runId);
  }

  async setRunInstruction(
    stream: StreamTabId,
    runId: StorageKey,
    instruction: InstructionUpdate | null,
  ): Promise<void> {
    await this._runInstructions.setInstruction(stream, runId, instruction);
  }

  async deleteRunInstruction(
    stream: StreamTabId,
    runId: StorageKey,
  ): Promise<void> {
    await this._runInstructions.deleteRun(stream, runId);
  }

  private loadActiveRunIds(): void {
    const stored = this.storage.get<Record<string, string | null>>(
      WorkspaceStateKey.ACTIVE_RUN_IDS,
      {},
    );

    // Restore active run IDs into consolidated ephemeral state
    for (const [stream, runId] of Object.entries(stored)) {
      if (runId) {
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

  // Task state management
  setTaskState(streamTabId: StreamTabId, taskState: TaskState): void {
    this.taskStates.set(streamTabId, taskState);
    this.clearStreamHints(streamTabId);

    // Create frontend stream state with correct discriminated type
    const agentCategory = taskState.agentConfig.agentCategory;
    if (!this._streamStates.has(streamTabId)) {
      this._streamStates.set(streamTabId, createStreamState(agentCategory));
    }

    this.saveTaskStates();
    this.cleanupToolUseAgentRegistry();
  }

  getTaskState(streamTabId: StreamTabId): TaskState | undefined {
    return this.taskStates.get(streamTabId);
  }

  clearTaskState(streamTabId: StreamTabId): void {
    const didDelete = this.taskStates.delete(streamTabId);
    this.clearStreamHints(streamTabId);
    if (didDelete) {
      this.saveTaskStates();
      this.cleanupToolUseAgentRegistry();
    }
  }

  getRunOutputFiles(
    stream: StreamTabId,
    options: { storageKey: StorageKey },
  ): Map<number, OutputFileInfo[]> | undefined {
    return this._outputFiles.getRun(stream, options.storageKey);
  }

  setExecutionId(streamTabId: StreamTabId, executionId: ExecutionId): void {
    this._executionIds.set(streamTabId, executionId);
    this.saveExecutionIds();
  }

  getExecutionId(streamTabId: StreamTabId): ExecutionId | undefined {
    return this._executionIds.get(streamTabId);
  }

  async clearStream(stream: StreamTabId): Promise<void> {
    await Promise.all([
      this._streamTabs.delete(stream),
      this._taskGroups.delete(stream),
      this._outputFiles.deleteStream(stream),
      this._usageStats.delete(stream),
      this._runInstructions.clearStream(stream),
    ]);

    const removedState = this.taskStates.delete(stream);
    this._executionIds.delete(stream);
    this._sessionState.delete(stream);
    this._streamStates.delete(stream);

    if (this._activeStream === stream) {
      this._activeStream =
        this._streamTabs.keys()[0] || PROGRESS_VIEW_DEFAULTS.activeStream;
      this.saveActiveStream();
    }

    if (removedState) {
      this.saveTaskStates();
      this.cleanupToolUseAgentRegistry();
    }
    this.saveExecutionIds();
    this.saveActiveRunIds();
  }

  async clearAll(): Promise<void> {
    this.logger.warn(
      '[Persistence] clearAll() called - this will delete all persisted data!',
      { data: { stack: new Error().stack } },
    );

    await Promise.all([
      this._streamTabs.clear(),
      this._taskGroups.clear(),
      this._outputFiles.clear(),
      this._usageStats.clear(),
      this._runInstructions.clear(),
    ]);
    this.taskStates.clear();
    this._executionIds.clear();
    this._sessionState.clear();
    this._streamStates.clear();
    this._activeStream = PROGRESS_VIEW_DEFAULTS.activeStream;
    this.saveActiveStream();
    this.saveTaskStates();
    this.saveExecutionIds();
    this.saveActiveRunIds();
    this.cleanupToolUseAgentRegistry();
  }

  async load(): Promise<void> {
    this.logger.info(
      '[Persistence] Starting state load from workspace storage',
    );

    await Promise.all([
      this._streamTabs.load(),
      this._taskGroups.load(),
      this._outputFiles.load(),
      this._usageStats.load(),
      this._runInstructions.load(),
    ]);

    this.logger.info('[Persistence] Managers loaded');

    this.loadActiveStream();
    this.loadTaskStates();
    this.loadExecutionIds();
    this.loadStreamSortOrder();
    this.loadAgentCategoryFilter();
    this.loadActiveRunIds();

    this.logger.info(
      `[Persistence] State load complete - taskStates: ${this.taskStates.size}, executionIds: ${this._executionIds.size}`,
    );
  }

  private loadActiveStream(): void {
    const savedActiveStream = this.storage.get<string>(
      WorkspaceStateKey.ACTIVE_STREAM_TAB,
      PROGRESS_VIEW_DEFAULTS.activeStream,
    );

    this._activeStream =
      savedActiveStream && this._streamTabs.has(savedActiveStream)
        ? savedActiveStream
        : (this._streamTabs.keys()[0] ?? PROGRESS_VIEW_DEFAULTS.activeStream);
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

    this._executionIds = entries.length > 0 ? new Map(entries) : new Map();
    if (entries.length > 0) {
      this.logger.debug(`Loaded execution IDs for ${entries.length} streams`);
    }
  }

  private loadRecord(key: WorkspaceStateKey): Record<string, unknown> {
    const value = this.storage.get<Record<string, unknown>>(key, {});
    return typeof value === 'object' && value && !Array.isArray(value)
      ? value
      : {};
  }

  private saveActiveStream(): void {
    void this.storage.update(
      WorkspaceStateKey.ACTIVE_STREAM_TAB,
      this._activeStream,
    );
  }

  private saveTaskStates(): void {
    const serialized = Object.fromEntries(this.taskStates);
    void this.storage.update(WorkspaceStateKey.TASK_STATES, serialized);
  }

  private cleanupToolUseAgentRegistry(): void {
    const activeStreams = new Set<StreamTabId>();
    for (const [stream, state] of this.taskStates.entries()) {
      if (isToolUseTaskState(state)) {
        activeStreams.add(stream);
      }
    }
    cleanupInactiveAgents(activeStreams);
  }

  private saveExecutionIds(): void {
    const executionIdsObj = mapToRecord(this._executionIds);
    void this.storage.update(WorkspaceStateKey.EXECUTION_IDS, executionIdsObj);
  }

  private loadStreamSortOrder(): void {
    const configDefault = getConfig(
      'texra.progressBoard.streamSortOrder',
      PROGRESS_VIEW_DEFAULTS.streamSortOrder,
    );
    this._streamSortOrder = this.storage.get(
      WorkspaceStateKey.STREAM_SORT_ORDER,
      configDefault,
    );
  }

  private saveStreamSortOrder(): void {
    void this.storage.update(
      WorkspaceStateKey.STREAM_SORT_ORDER,
      this._streamSortOrder,
    );
  }

  private loadAgentCategoryFilter(): void {
    const savedFilter = this.storage.get<string>(
      WorkspaceStateKey.STREAM_AGENT_FILTER,
      PROGRESS_VIEW_DEFAULTS.agentCategoryFilter,
    );
    const parsed = AgentCategoryFilterSchema.safeParse(savedFilter);
    this._agentCategoryFilter = parsed.success
      ? parsed.data
      : PROGRESS_VIEW_DEFAULTS.agentCategoryFilter;
  }

  private saveAgentCategoryFilter(): void {
    void this.storage.update(
      WorkspaceStateKey.STREAM_AGENT_FILTER,
      this._agentCategoryFilter,
    );
  }
}
