// Third-party imports
import { z } from 'zod';

// Local imports - agent metadata
import { AgentCategory } from '@agent/core/AgentDataclass';
// Internal imports
import { isAgentTypeFilter } from '@agent/types/AgentStreamTypes';
// Type imports
import type {
  StreamTabId,
  ExecutionId,
  StorageKey,
} from '@agent/types/IdentifierTypes';
import type { OutputFileInfo } from '@agent/output/types';
// Internal imports
import { cleanupInactiveAgents } from '@agent/toolUse/ToolUseAgentRegistry';
import { normalizeRunId } from '@common/constants/runIds';
import { workspaceSM, WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger, type ContextStateData } from '@logger/AgentLogger';
import type { TaskGroup } from '@logger/LogTypes';
import {
  TaskState,
  TaskStateSchema,
  isToolUseTaskState,
  isWorkflowTaskState,
} from '@logger/TaskState';
import type { AgentFilter } from '@progressView/types';
import {
  StreamTabsManager,
  TaskGroupManager,
  OutputFilesManager,
  UsageStatsManager,
  RunInstructionManager,
} from '@progressView/managers';
import type { StateStorage } from '@progressView/persistence/PersistentMapManager';
import { mapToRecord } from '@progressView/persistence/serializationUtils';
import { getConfig } from '@utils/config';
import type { TodoItem } from '@eventBus/schemas';

/**
 * Schema for ephemeral stream metadata hints.
 * Used to display UI indicators before TaskState is fully populated.
 */
export const StreamHintsSchema = z.object({
  sessionCategory: z.enum(AgentCategory).optional(),
  isRemote: z.boolean().optional(),
  hasMultipleOutputs: z.boolean().optional(),
});

export type StreamHints = z.infer<typeof StreamHintsSchema>;

/**
 * Consolidated ephemeral state for a single stream.
 *
 * Groups all session-only, non-persisted state that needs to be tracked per-stream.
 * This eliminates the scattered Maps pattern (5 separate Maps → 1 Map with structured values).
 */
interface StreamEphemeralState {
  /** UI hints before TaskState is fully populated */
  hints: StreamHints;
  /** Todos from agent, replayed on stream switch */
  todos: TodoItem[];
  /** Context utilization (input tokens vs context window) */
  contextState: ContextStateData | null;
  /** Most recently viewed run for this stream */
  activeRunId: StorageKey | null;
}

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
  private _activeStream: StreamTabId = '';
  private _streamSortOrder = 'time';
  private _agentTypeFilter: AgentFilter = 'all';
  private readonly taskStates = new Map<StreamTabId, TaskState>();
  private _executionIds: Map<StreamTabId, ExecutionId> = new Map();

  /**
   * Consolidated ephemeral state per stream.
   *
   * Groups all non-persisted, session-only data:
   * - hints: UI indicators before TaskState is populated
   * - todos: Agent todos for replay on stream switch
   * - contextState: Token utilization display
   * - activeRunId: Most recently viewed run
   */
  private _ephemeral = new Map<StreamTabId, StreamEphemeralState>();

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

  get runInstructions(): RunInstructionManager {
    return this._runInstructions;
  }

  // Active stream management
  get activeStream(): StreamTabId {
    return this._activeStream;
  }

  set activeStream(stream: StreamTabId) {
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

  get agentTypeFilter(): AgentFilter {
    return this._agentTypeFilter;
  }

  set agentTypeFilter(filter: AgentFilter) {
    if (!isAgentTypeFilter(filter)) {
      this.logger.warn(`Invalid agent filter: ${filter}, defaulting to 'all'`);
      filter = 'all';
    }
    this._agentTypeFilter = filter;
    this.saveAgentTypeFilter();
  }

  // ============================================================================
  // Ephemeral State Management (consolidated)
  // ============================================================================

  /** Get or create ephemeral state for a stream */
  private getOrCreateEphemeral(stream: StreamTabId): StreamEphemeralState {
    let state = this._ephemeral.get(stream);
    if (!state) {
      state = { hints: {}, todos: [], contextState: null, activeRunId: null };
      this._ephemeral.set(stream, state);
    }
    return state;
  }

  /** Update stream hints (merges with existing) */
  updateStreamHints(streamTabId: StreamTabId, hints: StreamHints): void {
    const state = this.getOrCreateEphemeral(streamTabId);
    state.hints = { ...state.hints, ...hints };
  }

  /** Get stream hints */
  getStreamHints(streamTabId: StreamTabId): StreamHints {
    return this._ephemeral.get(streamTabId)?.hints ?? {};
  }

  /** Clear stream hints (resets to empty) */
  clearStreamHints(streamTabId: StreamTabId): void {
    this.clearEphemeralField(streamTabId, 'hints', {});
  }

  /** Set todos for a stream */
  setTodos(stream: StreamTabId, todos: TodoItem[]): void {
    this.getOrCreateEphemeral(stream).todos = todos;
  }

  /** Get todos for a stream */
  getTodos(stream: StreamTabId): TodoItem[] | undefined {
    const todos = this._ephemeral.get(stream)?.todos;
    return todos?.length ? todos : undefined;
  }

  /** Clear todos for a stream */
  clearTodos(stream: StreamTabId): void {
    this.clearEphemeralField(stream, 'todos', []);
  }

  /** Clear all todos across all streams */
  clearAllTodos(): void {
    for (const state of this._ephemeral.values()) {
      state.todos = [];
    }
  }

  /** Set context state for a stream */
  setContextState(stream: StreamTabId, contextState: ContextStateData): void {
    this.getOrCreateEphemeral(stream).contextState = contextState;
  }

  /** Get context state for a stream */
  getContextState(stream: StreamTabId): ContextStateData | undefined {
    return this._ephemeral.get(stream)?.contextState ?? undefined; // null → undefined
  }

  /** Clear context state for a stream */
  clearContextState(stream: StreamTabId): void {
    this.clearEphemeralField(stream, 'contextState', null);
  }

  /** Helper to clear a specific ephemeral field */
  private clearEphemeralField<K extends keyof StreamEphemeralState>(
    stream: StreamTabId,
    field: K,
    emptyValue: StreamEphemeralState[K],
  ): void {
    const state = this._ephemeral.get(stream);
    if (state) {
      state[field] = emptyValue;
    }
  }

  /** Set active run ID for a stream (persisted) */
  setActiveRunId(stream: StreamTabId, runId: string | null): void {
    const storageKey = runId ? normalizeRunId(runId) : null;
    this.getOrCreateEphemeral(stream).activeRunId = storageKey;
    this.saveActiveRunIds();
  }

  /** Get active run ID for a stream */
  getActiveRunId(stream: StreamTabId): StorageKey | null {
    return this._ephemeral.get(stream)?.activeRunId ?? null;
  }

  /** Clear active run for a stream */
  clearActiveRun(stream: StreamTabId): void {
    const state = this._ephemeral.get(stream);
    if (state && state.activeRunId !== null) {
      state.activeRunId = null;
      this.saveActiveRunIds();
    }
  }

  /**
   * Resolve and optionally persist the active run ID for a stream.
   *
   * Resolution strategy (in order):
   * 1. If specific runId requested → validate it exists, return it or null
   * 2. If previously active runId exists → return it (already persisted)
   * 3. Auto-select: single candidate or most recent run
   *
   * For tool-use agents: The runId will be the executionId (same UUID)
   * For workflow agents: The runId will be a task group ID
   *
   * @param stream - The stream to resolve for
   * @param requested - Optional specific runId to use
   * @param options.persist - Whether to save the resolved runId (default: true)
   * @returns The resolved StorageKey, or null if none found
   */
  resolveRunId(
    stream: StreamTabId,
    requested?: string | null,
    options?: { persist?: boolean },
  ): StorageKey | null {
    const shouldPersist = options?.persist ?? true;

    // 1. Specific runId requested - validate it exists
    if (requested) {
      const candidates = this.collectRunCandidates(stream);
      if (!candidates.has(requested)) return null;
      const normalized = normalizeRunId(requested);
      if (shouldPersist) this.setActiveRunId(stream, normalized);
      return normalized;
    }

    // 2. Use existing active run if already set (already normalized)
    const current = this.getActiveRunId(stream);
    if (current) return current;

    // 3. Auto-select: collect candidates once, then pick latest or single
    const candidates = this.collectRunCandidates(stream);
    if (candidates.size === 0) return null;

    const selected =
      candidates.size === 1
        ? [...candidates][0]
        : this.findLatestRunId(stream, candidates);

    if (!selected) return null;
    const normalized = normalizeRunId(selected);
    if (shouldPersist) this.setActiveRunId(stream, normalized);
    return normalized;
  }

  /**
   * Collect all valid run IDs for a stream.
   *
   * Run candidates come from:
   * - Root task groups (workflow runs)
   * - Run-scoped data: instructions, output files, usage stats
   *
   * This is the single source of truth for run discovery.
   */
  private collectRunCandidates(stream: StreamTabId): Set<string> {
    const candidates = new Set<string>();

    // Root task groups are primary run identifiers (workflow sessions)
    for (const group of this._taskGroups.getStreamGroups(stream).values()) {
      if (!group.parentGroupId) {
        candidates.add(group.id);
      }
    }

    // Run-scoped data sources (tool-use sessions use these)
    const sources = [
      this._runInstructions.getInstructions(stream),
      this._outputFiles.getFiles(stream),
      this._outputFiles.getMissingOutputs(stream),
      this._usageStats.getRunUsage(stream),
    ];

    for (const source of sources) {
      for (const runId of source.keys()) {
        if (runId) candidates.add(runId);
      }
    }

    return candidates;
  }

  /**
   * Find the most recent run from candidates.
   * Prefers task groups by startTime, falls back to usage runs for tool-use sessions.
   *
   * @param stream - The stream to search in
   * @param candidates - Pre-collected run candidates (avoids redundant iteration)
   */
  private findLatestRunId(
    stream: StreamTabId,
    candidates?: Set<string>,
  ): string | null {
    const groups = this._taskGroups.getStreamGroups(stream);
    let latest: { id: string; start: number } | null = null;

    // If candidates provided, only consider those; otherwise check all root groups
    const candidateSet = candidates ?? this.collectRunCandidates(stream);

    for (const group of groups.values()) {
      if (group.parentGroupId) continue;
      if (!candidateSet.has(group.id)) continue;

      const startTime = group.startTime;
      if (!latest || startTime >= latest.start) {
        latest = { id: group.id, start: startTime };
      }
    }

    // For tool-use sessions, there are no task groups - fall back to usage runs
    if (!latest) {
      const usageRuns = this._usageStats.getRunUsage(stream);
      if (usageRuns.size > 0) {
        // Return the last key (most recently added run)
        return [...usageRuns.keys()].at(-1) ?? null;
      }
    }

    return latest?.id ?? null;
  }

  private loadActiveRunIds(): void {
    const stored = this.storage.get<Record<string, string | null>>(
      WorkspaceStateKey.ACTIVE_RUN_IDS,
      {},
    );

    // Restore active run IDs into consolidated ephemeral state
    for (const [stream, runId] of Object.entries(stored)) {
      if (runId) {
        this.getOrCreateEphemeral(stream as StreamTabId).activeRunId =
          normalizeRunId(runId);
      }
    }
  }

  private saveActiveRunIds(): void {
    // Extract active run IDs from consolidated ephemeral state
    const record: Record<string, string | null> = {};
    for (const [stream, state] of this._ephemeral.entries()) {
      if (state.activeRunId !== null) {
        record[stream] = state.activeRunId;
      }
    }
    void this.storage.update(WorkspaceStateKey.ACTIVE_RUN_IDS, record);
  }

  /**
   * Reset workflow output metadata for the provided stream.
   *
   * Clears outputFiles, useMultipleOutputs, and the output flag.
   * Returns true when state was modified and persisted, false when
   * already cleared or not a workflow task.
   */
  clearOutputState(streamTabId: StreamTabId): boolean {
    const taskState = this.getTaskState(streamTabId);
    if (!taskState || !isWorkflowTaskState(taskState)) {
      return false;
    }

    const hasPersistedOutputs = taskState.agentConfig.outputFiles.length > 0;
    const usesMultipleOutputs = taskState.agentConfig.useMultipleOutputs;
    const outputFlagEnabled = taskState.activeFiles.output;

    if (!hasPersistedOutputs && !usesMultipleOutputs && !outputFlagEnabled) {
      return false;
    }

    const updatedState = {
      ...taskState,
      agentConfig: {
        ...taskState.agentConfig,
        outputFiles: [],
        useMultipleOutputs: false,
      },
      activeFiles: {
        ...taskState.activeFiles,
        output: false,
      },
    };

    this.setTaskState(streamTabId, updatedState);
    return true;
  }

  // Task state management
  setTaskState(streamTabId: StreamTabId, taskState: TaskState): void {
    this.taskStates.set(streamTabId, taskState);
    this.clearStreamHints(streamTabId);
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

  getAllTaskStates(): Map<StreamTabId, TaskState> {
    return new Map(this.taskStates);
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

  /**
   * Get all execution IDs as a read-only Map.
   * Used for detecting waiting streams from persisted flows on startup.
   */
  getAllExecutionIds(): ReadonlyMap<StreamTabId, ExecutionId> {
    return this._executionIds;
  }

  clearExecutionId(streamTabId: StreamTabId): void {
    this._executionIds.delete(streamTabId);
    this.saveExecutionIds();
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
    this._ephemeral.delete(stream);

    // Update active stream if necessary
    if (this._activeStream === stream) {
      this._activeStream = this._streamTabs.keys()[0] || '';
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
    this._ephemeral.clear();
    this._activeStream = '';
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
    this.loadAgentTypeFilter();
    this.loadActiveRunIds();
  }

  /**
   * Load active stream from persistence
   */
  private loadActiveStream(): void {
    const savedActiveStream = this.storage.get<string>(
      WorkspaceStateKey.ACTIVE_STREAM_TAB,
      '',
    );

    if (savedActiveStream && this._streamTabs.has(savedActiveStream)) {
      this._activeStream = savedActiveStream;
    } else {
      this._activeStream = this._streamTabs.keys()[0] || '';
    }
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
  ): Array<[string, unknown]> {
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

    if (entries.length > 0) {
      this._executionIds = new Map(entries);
      this.logger.debug(`Loaded execution IDs for ${entries.length} streams`);
    } else {
      this._executionIds.clear();
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
      'time',
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

  private loadAgentTypeFilter(): void {
    const savedFilter = this.storage.get<string>(
      WorkspaceStateKey.STREAM_AGENT_FILTER,
      'all',
    );
    this._agentTypeFilter = isAgentTypeFilter(savedFilter)
      ? savedFilter
      : 'all';
  }

  private saveAgentTypeFilter(): void {
    void this.storage.update(
      WorkspaceStateKey.STREAM_AGENT_FILTER,
      this._agentTypeFilter,
    );
  }
}
