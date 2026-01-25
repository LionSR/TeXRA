// Third-party imports
import { z } from 'zod';

// Local imports - shared schemas
import {
  createStreamState,
  StorageKeySchema,
  TodoItemSchema,
  type StreamState,
} from '@shared/schemas';

// Local imports - agent
import { AgentCategory } from '@agent/core/AgentDataclass';
import { cleanupInactiveAgents } from '@agent/toolUse/ToolUseAgentRegistry';
import {
  isAgentCategoryFilter,
  type AgentCategoryFilter,
} from '@agent/types/AgentStreamTypes';

// Local imports - common
import { normalizeRunId } from '@common/constants/runIds';
import { workspaceSM, WorkspaceStateKey } from '@common/state/stateManager';

// Local imports - logger
import {
  AgentLogger,
  ContextStateDataSchema,
  type ContextStateData,
} from '@logger/AgentLogger';
import {
  TaskState,
  TaskStateSchema,
  isToolUseTaskState,
} from '@logger/TaskState';

// Local imports - progress view
import {
  OutputFilesManager,
  RunInstructionManager,
  StreamTabsManager,
  TaskGroupManager,
  UsageStatsManager,
} from '@progressView/managers';
import type { StateStorage } from '@progressView/persistence/PersistentMapManager';
import { mapToRecord } from '@progressView/persistence/serializationUtils';

// Local imports - utils
import { getConfig } from '@utils/config';

// Type imports
import type {
  ExecutionId,
  InstructionUpdate,
  OutputFileInfo,
  StorageKey,
  StreamTabId,
  TodoItem,
} from '@shared/schemas';

/**
 * Schema for ephemeral stream metadata hints.
 * Used to display UI indicators before TaskState is fully populated.
 */
export const StreamHintsSchema = z.object({
  agentCategory: z.enum(AgentCategory).optional(),
  isRemote: z.boolean().optional(),
  hasMultipleOutputs: z.boolean().optional(),
});

export type StreamHints = z.infer<typeof StreamHintsSchema>;

/**
 * Schema for consolidated session state per stream.
 * Single source of truth for defaults via .prefault().
 *
 * Contains both ephemeral (session-only) and persisted fields:
 * - Ephemeral (not persisted): hints, todos, contextState
 * - Persisted: activeRunId (saved to workspace storage)
 */
export const StreamSessionStateSchema = z.object({
  /** UI hints before TaskState is fully populated (ephemeral) */
  hints: StreamHintsSchema.prefault({}),
  /** Todos from agent, replayed on stream switch (ephemeral) */
  todos: z.array(TodoItemSchema).prefault([]),
  /** Context utilization (input tokens vs context window) (ephemeral) */
  contextState: ContextStateDataSchema.nullable().prefault(null),
  /** Most recently viewed run for this stream (persisted) */
  activeRunId: StorageKeySchema.nullable().prefault(null),
});

/**
 * Consolidated session state for a single stream.
 * Type derived from schema - schema is the single source of truth.
 */
type StreamSessionState = z.output<typeof StreamSessionStateSchema>;

/**
 * Active stream identifier, or empty string when no stream is selected.
 * Empty string represents the "no selection" state and is used throughout
 * the progress view to indicate that no stream content should be displayed.
 */
export type ActiveStreamId = StreamTabId | '';

/** Default values for ProgressViewState UI properties */
const PROGRESS_VIEW_DEFAULTS = {
  /** Empty string indicates no stream is selected */
  activeStream: '' as ActiveStreamId,
  streamSortOrder: 'time',
  agentCategoryFilter: 'all' as AgentCategoryFilter,
} as const;

/**
 * Core state management for the progress view.
 * Composes focused manager classes and provides a clean interface
 * for state operations while hiding implementation details.
 */
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

  /**
   * Frontend-ready stream states with discriminated types.
   * Backend is single source of truth - frontend just stores what we send.
   */
  private _streamStates = new Map<StreamTabId, StreamState>();

  /**
   * Consolidated session state per stream.
   *
   * Contains both ephemeral and persisted fields:
   * - Ephemeral: hints, todos, contextState
   * - Persisted: activeRunId
   */
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
    // Initialize focused managers
    this._streamTabs = new StreamTabsManager(resolvedStorage);
    this._taskGroups = new TaskGroupManager(resolvedStorage);
    this._outputFiles = new OutputFilesManager(resolvedStorage);
    this._usageStats = new UsageStatsManager(resolvedStorage);
    this._runInstructions = new RunInstructionManager(resolvedStorage);
  }

  // Manager accessors - provide direct access to focused managers
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

  // Active stream management
  /** Get the active stream ID, or empty string if no stream is selected */
  get activeStream(): ActiveStreamId {
    return this._activeStream;
  }

  /** Set the active stream ID. Use empty string to clear the selection. */
  set activeStream(stream: ActiveStreamId) {
    this._activeStream = stream;
    this.saveActiveStream();
  }

  /**
   * Ensure the active stream is valid within the given set of available streams.
   *
   * This is the SINGLE SOURCE OF TRUTH for active stream resolution. If the
   * current active stream is not in the available set (e.g., due to filtering),
   * this method picks the first available stream and updates the state.
   *
   * IMPORTANT: When availableStreams is empty, we preserve and return the current
   * activeStream to avoid clearing content during temporary filter mismatches
   * (e.g., during resume flow race conditions). The return value is always
   * consistent with state._activeStream.
   *
   * @param availableStreams - Array of stream IDs that are currently visible/available
   * @returns The resolved active stream ID (current active if no streams available)
   */
  resolveActiveStream(availableStreams: StreamTabId[]): StreamTabId {
    const currentActive = this._activeStream;

    // If current active stream is in the available list, keep it
    if (availableStreams.includes(currentActive)) {
      return currentActive;
    }

    // Pick the first available stream, or preserve current if none available.
    // Preserving current when availableStreams is empty prevents clearing content
    // during temporary filter mismatches (e.g., during resume flow race conditions).
    const resolved = availableStreams[0];

    if (resolved && resolved !== currentActive) {
      this._activeStream = resolved;
      this.saveActiveStream();
    }

    // Return resolved if valid, otherwise preserve current active.
    // This keeps return value consistent with state._activeStream.
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
    if (!isAgentCategoryFilter(filter)) {
      this.logger.warn(
        `Invalid agent filter: ${filter}, defaulting to '${PROGRESS_VIEW_DEFAULTS.agentCategoryFilter}'`,
      );
      filter = PROGRESS_VIEW_DEFAULTS.agentCategoryFilter;
    }
    this._agentCategoryFilter = filter;
    this.saveAgentCategoryFilter();
  }

  // ============================================================================
  // Session State Management (per-stream ephemeral + persisted fields)
  // ============================================================================

  /** Get or create session state for a stream. Uses schema defaults. */
  private getOrCreateSession(stream: StreamTabId): StreamSessionState {
    let state = this._sessionState.get(stream);
    if (!state) {
      // Schema provides defaults via .prefault() - single source of truth
      state = StreamSessionStateSchema.parse({});
      this._sessionState.set(stream, state);
    }
    return state;
  }

  /** Update stream hints (merges with existing, validates result) */
  updateStreamHints(streamTabId: StreamTabId, hints: StreamHints): void {
    const state = this.getOrCreateSession(streamTabId);
    // Validate merged hints against schema
    state.hints = StreamHintsSchema.parse({ ...state.hints, ...hints });
  }

  /** Get stream hints */
  getStreamHints(streamTabId: StreamTabId): StreamHints {
    return this._sessionState.get(streamTabId)?.hints ?? {};
  }

  /** Clear stream hints (resets to empty) */
  clearStreamHints(streamTabId: StreamTabId): void {
    this.clearSessionField(streamTabId, 'hints', {});
  }

  /** Set todos for a stream */
  setTodos(stream: StreamTabId, todos: TodoItem[]): void {
    this.getOrCreateSession(stream).todos = todos;
  }

  /** Get todos for a stream */
  getTodos(stream: StreamTabId): TodoItem[] | undefined {
    const todos = this._sessionState.get(stream)?.todos;
    return todos?.length ? todos : undefined;
  }

  /** Clear todos for a stream */
  clearTodos(stream: StreamTabId): void {
    this.clearSessionField(stream, 'todos', []);
  }

  /** Clear all todos across all streams */
  clearAllTodos(): void {
    for (const state of this._sessionState.values()) {
      state.todos = [];
    }
  }

  /** Set context state for a stream */
  setContextState(stream: StreamTabId, contextState: ContextStateData): void {
    this.getOrCreateSession(stream).contextState = contextState;
  }

  /** Get context state for a stream */
  getContextState(stream: StreamTabId): ContextStateData | undefined {
    return this._sessionState.get(stream)?.contextState ?? undefined; // null → undefined
  }

  /** Clear context state for a stream */
  clearContextState(stream: StreamTabId): void {
    this.clearSessionField(stream, 'contextState', null);
  }

  /** Helper to clear a specific ephemeral field */
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

  /** Set active run ID for a stream (persisted) */
  setActiveRunId(stream: StreamTabId, runId: string | null): void {
    const storageKey = runId ? normalizeRunId(runId) : null;
    this.getOrCreateSession(stream).activeRunId = storageKey;
    this.saveActiveRunIds();
  }

  /** Get active run ID for a stream */
  getActiveRunId(stream: StreamTabId): StorageKey | null {
    return this._sessionState.get(stream)?.activeRunId ?? null;
  }

  /** Clear active run for a stream */
  clearActiveRun(stream: StreamTabId): void {
    const state = this._sessionState.get(stream);
    if (state && state.activeRunId !== null) {
      state.activeRunId = null;
      this.saveActiveRunIds();
    }
  }

  // ============================================================================
  // Frontend Stream State Management
  // ============================================================================

  /**
   * Get frontend-ready stream state for a stream.
   * Returns undefined if stream doesn't exist.
   */
  getStreamState(stream: StreamTabId): StreamState | undefined {
    return this._streamStates.get(stream);
  }

  /**
   * Get or create frontend stream state for a stream.
   * Creates with correct discriminated type based on agent category.
   */
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

  /**
   * Update frontend stream state for a stream.
   * The updater receives the current state and returns the updated state.
   * Type-safe: updater must return same discriminated type as input.
   */
  updateStreamState(
    stream: StreamTabId,
    updater: (prev: StreamState) => StreamState,
  ): void {
    const current = this._streamStates.get(stream);
    if (current) {
      this._streamStates.set(stream, updater(current));
    }
  }

  /**
   * Get all frontend stream states as a record for sending to frontend.
   * This is the source of truth - frontend just stores what we send.
   */
  getAllStreamStates(): Record<StreamTabId, StreamState> {
    return Object.fromEntries(this._streamStates.entries());
  }

  /**
   * Clear frontend stream state for a stream.
   */
  clearStreamState(stream: StreamTabId): void {
    this._streamStates.delete(stream);
  }

  // ============================================================================
  // Run Instruction Management (delegation to internal manager)
  // ============================================================================

  /** Get all instructions for a stream */
  getRunInstructions(stream: StreamTabId): Map<string, InstructionUpdate> {
    return this._runInstructions.getInstructions(stream);
  }

  /** Get instruction for a specific run */
  getRunInstruction(
    stream: StreamTabId,
    runId: StorageKey,
  ): InstructionUpdate | undefined {
    return this._runInstructions.getInstructions(stream).get(runId);
  }

  /** Set or clear an instruction for a run */
  async setRunInstruction(
    stream: StreamTabId,
    runId: StorageKey,
    instruction: InstructionUpdate | null,
  ): Promise<void> {
    await this._runInstructions.setInstruction(stream, runId, instruction);
  }

  /** Delete instruction for a run */
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

  /**
   * Get output files for a stream using storageKey.
   *
   * StorageKey is THE single source of truth for storage operations:
   * - Workflow agents: storageKey = task group ID
   * - Tool-use agents: storageKey = executionId
   *
   * @param stream - The stream tab ID
   * @param options.storageKey - THE branded key for storage lookup.
   * @see IdentifierTypes.ts for the full execution model documentation
   */
  getRunOutputFiles(
    stream: StreamTabId,
    options: { storageKey: StorageKey },
  ): Map<number, OutputFileInfo[]> | undefined {
    return this._outputFiles.getRun(stream, options.storageKey);
  }

  // Execution ID management
  setExecutionId(streamTabId: StreamTabId, executionId: ExecutionId): void {
    this._executionIds.set(streamTabId, executionId);
    this.saveExecutionIds();
  }

  getExecutionId(streamTabId: StreamTabId): ExecutionId | undefined {
    return this._executionIds.get(streamTabId);
  }

  // Stream cleanup operations
  async clearStream(stream: StreamTabId): Promise<void> {
    // Clear persisted manager data in parallel
    await Promise.all([
      this._streamTabs.delete(stream),
      this._taskGroups.delete(stream),
      this._outputFiles.deleteStream(stream),
      this._usageStats.delete(stream),
      this._runInstructions.clearStream(stream),
    ]);

    // Clear ephemeral state (consolidated Map)
    const removedState = this.taskStates.delete(stream);
    this._executionIds.delete(stream);
    this._sessionState.delete(stream);
    this._streamStates.delete(stream);

    // Update active stream if necessary
    if (this._activeStream === stream) {
      this._activeStream =
        this._streamTabs.keys()[0] || PROGRESS_VIEW_DEFAULTS.activeStream;
      this.saveActiveStream();
    }

    // Persist changes
    if (removedState) {
      this.saveTaskStates();
      this.cleanupToolUseAgentRegistry();
    }
    this.saveExecutionIds();
    this.saveActiveRunIds();
  }

  async clearAll(): Promise<void> {
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

  /**
   * Load all state from persistence
   */
  async load(): Promise<void> {
    // Load basic state first (async managers)
    await Promise.all([
      this._streamTabs.load(),
      this._taskGroups.load(),
      this._outputFiles.load(),
      this._usageStats.load(),
      this._runInstructions.load(),
    ]);

    // Load dependent state after basic state is loaded (synchronous operations)
    this.loadActiveStream(); // Depends on stream tabs being loaded
    this.loadTaskStates();
    this.loadExecutionIds();
    this.loadStreamSortOrder();
    this.loadAgentCategoryFilter();
    this.loadActiveRunIds();
  }

  /**
   * Load active stream from persistence
   */
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

  /**
   * Load task states from persistence.
   * Handles both current flat format and legacy workflow/toolUse format.
   */
  private loadTaskStates(): void {
    const raw = this.loadRecord(WorkspaceStateKey.TASK_STATES);
    this.taskStates.clear();

    if (Object.keys(raw).length === 0) {
      this.cleanupToolUseAgentRegistry();
      return;
    }

    // Collect entries from legacy format (workflow/toolUse sub-objects) or flat format
    const entries = this.extractTaskStateEntries(raw);

    let loaded = 0;
    for (const [stream, rawState] of entries) {
      const parseResult = TaskStateSchema.safeParse(rawState);
      if (!parseResult.success) {
        this.logger.debug(
          `Skipping invalid task state for stream ${stream}: ${parseResult.error.message}`,
        );
        continue;
      }

      this.taskStates.set(stream as StreamTabId, parseResult.data as TaskState);
      loaded += 1;
    }

    if (loaded > 0) {
      this.logger.debug(`Loaded task states for ${loaded} streams`);
    }

    this.cleanupToolUseAgentRegistry();
  }

  /**
   * Extract task state entries from either legacy or flat format.
   */
  private extractTaskStateEntries(
    raw: Record<string, unknown>,
  ): [string, unknown][] {
    const isPlainObject = (v: unknown): v is Record<string, unknown> =>
      v !== null && typeof v === 'object' && !Array.isArray(v);

    // Legacy format: collect from workflow/toolUse buckets
    const legacyBuckets = [raw.workflow, raw.toolUse].filter(isPlainObject);
    if (legacyBuckets.length > 0) {
      return legacyBuckets.flatMap((bucket) =>
        Object.entries(bucket).filter(([, v]) => isPlainObject(v)),
      );
    }

    // Flat format: direct entries
    return Object.entries(raw).filter(([, v]) => isPlainObject(v));
  }

  /**
   * Load execution IDs from persistence
   */
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
    // Guard against non-object values (arrays, primitives)
    return typeof value === 'object' && value && !Array.isArray(value)
      ? value
      : {};
  }

  /**
   * Save active stream to persistence
   */
  private saveActiveStream(): void {
    void this.storage.update(
      WorkspaceStateKey.ACTIVE_STREAM_TAB,
      this._activeStream,
    );
  }

  /**
   * Save task states to persistence
   */
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

  /**
   * Save execution IDs to persistence
   */
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
    this._agentCategoryFilter = isAgentCategoryFilter(savedFilter)
      ? savedFilter
      : PROGRESS_VIEW_DEFAULTS.agentCategoryFilter;
  }

  private saveAgentCategoryFilter(): void {
    void this.storage.update(
      WorkspaceStateKey.STREAM_AGENT_FILTER,
      this._agentCategoryFilter,
    );
  }
}
