// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports - agent metadata
import {
  AgentCategory,
  resolveAgentSessionDescriptor,
} from '@agent/core/AgentDataclass';
// Type imports
import type { AgentType } from '@agent/core/AgentDataclass';
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
import { AgentLogger } from '@logger/AgentLogger';
import type { TaskGroup } from '@logger/LogTypes';
import {
  TaskState,
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
 * Core state management for the progress view.
 * Composes focused manager classes and provides a clean interface
 * for state operations while hiding implementation details.
 */
const cloneTaskState = (state: TaskState): TaskState => {
  if (isWorkflowTaskState(state)) {
    return {
      ...state,
      agentConfig: { ...state.agentConfig },
      activeFiles: { ...state.activeFiles },
    };
  }

  return {
    ...state,
    agentConfig: { ...state.agentConfig },
    toolSessionState: state.toolSessionState
      ? { ...state.toolSessionState }
      : undefined,
  };
};

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
   * Ephemeral stream metadata hints keyed by stream ID.
   *
   * When a stream becomes active before its {@link TaskState} is persisted,
   * progress events populate this map so the UI can immediately show correct
   * indicators (session category, remote status, multiple outputs).
   * Once canonical metadata is stored via setTaskState, the entry is cleared.
   */
  private _streamHints = new Map<StreamTabId, StreamHints>();
  private _activeRunIds: Map<StreamTabId, StorageKey | null> = new Map();
  /**
   * Ephemeral todos storage keyed by stream ID.
   * Todos are stored here so they can be replayed when switching streams.
   * Not persisted - session-only state that's also stored in AgentWorkspaceState.
   */
  private _todos: Map<StreamTabId, TodoItem[]> = new Map();
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
   * @param availableStreams - Array of stream IDs that are currently visible/available
   * @returns The resolved active stream ID (may be empty string if no streams available)
   */
  resolveActiveStream(availableStreams: StreamTabId[]): StreamTabId {
    const currentActive = this._activeStream;

    // If current active stream is in the available list, keep it
    if (availableStreams.includes(currentActive)) {
      return currentActive;
    }

    // Otherwise, pick the first available stream (or empty if none)
    const resolved = availableStreams[0] ?? '';

    // Only update state if it actually changed
    if (resolved !== currentActive) {
      this._activeStream = resolved;
      this.saveActiveStream();
    }

    return resolved;
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

  // Stream metadata hint management (ephemeral, non-persistent)
  // Provides UI hints before TaskState is fully populated
  updateStreamHints(streamTabId: StreamTabId, hints: StreamHints): void {
    const existing = this._streamHints.get(streamTabId) ?? {};
    this._streamHints.set(streamTabId, { ...existing, ...hints });
  }

  getStreamHints(streamTabId: StreamTabId): StreamHints {
    return this._streamHints.get(streamTabId) ?? {};
  }

  clearStreamHints(streamTabId: StreamTabId): void {
    this._streamHints.delete(streamTabId);
  }

  // Todo management (ephemeral, non-persistent)
  /**
   * Set todos for a stream.
   * Stores todos so they can be replayed when switching streams.
   */
  setTodos(stream: StreamTabId, todos: TodoItem[]): void {
    this._todos.set(stream, todos);
  }

  /**
   * Get todos for a stream.
   */
  getTodos(stream: StreamTabId): TodoItem[] | undefined {
    return this._todos.get(stream);
  }

  /**
   * Clear todos for a stream.
   */
  clearTodos(stream: StreamTabId): void {
    this._todos.delete(stream);
  }

  /**
   * Clear all todos across all streams.
   */
  clearAllTodos(): void {
    this._todos.clear();
  }

  setActiveRunId(stream: StreamTabId, runId: string | null): void {
    // Normalize at boundary to ensure branded StorageKey storage
    const storageKey = runId ? normalizeRunId(runId) : null;
    this._activeRunIds.set(stream, storageKey);
    this.saveActiveRunIds();
  }

  getActiveRunId(stream: StreamTabId): StorageKey | null {
    return this._activeRunIds.get(stream) ?? null;
  }

  clearActiveRun(stream: StreamTabId): void {
    if (!this._activeRunIds.delete(stream)) {
      return;
    }
    this.saveActiveRunIds();
  }

  /**
   * Resolve and optionally persist the active run ID for a stream.
   *
   * This method determines which run (task group) should be active for display
   * in the progress view. The resolution strategy:
   * 1. If a specific runId is requested, validate it exists and use it
   * 2. Otherwise, check for a previously active runId
   * 3. If only one run exists, use that
   * 4. Otherwise, find the most recent run
   *
   * For tool-use agents: The runId will be the executionId (same UUID)
   * For workflow agents: The runId will be a task group ID
   *
   * @param stream - The stream to resolve for
   * @param requested - Optional specific runId to use
   * @param options.persist - Whether to save the resolved runId (default: true)
   * @returns The resolved runId, or null if none found
   */
  resolveRunId(
    stream: StreamTabId,
    requested?: string | null,
    options?: { persist?: boolean },
  ): string | null {
    const persist = options?.persist ?? true;
    const preferred = requested ?? null;

    let candidates: Set<string> | null = null;
    const ensureCandidates = (): Set<string> => {
      if (!candidates) {
        candidates = this.collectRunCandidates(stream);
      }
      return candidates;
    };

    if (preferred) {
      if (!ensureCandidates().has(preferred)) {
        return null;
      }
      if (persist) {
        this.setActiveRunId(stream, preferred);
      }
      return preferred;
    }

    const current = this.getActiveRunId(stream);
    if (current) {
      return current;
    }

    const candidateSet = ensureCandidates();
    if (candidateSet.size === 1) {
      const only = candidateSet.values().next().value;
      if (only) {
        if (persist) {
          this.setActiveRunId(stream, only);
        }
        return only;
      }
    }

    const latest = this.findLatestRunId(stream);
    if (latest) {
      if (persist) {
        this.setActiveRunId(stream, latest);
      }
      return latest;
    }

    return null;
  }

  private collectRunCandidates(stream: StreamTabId): Set<string> {
    const candidates = new Set<string>();

    const instructionRuns = this._runInstructions.getInstructions(stream);
    for (const runId of instructionRuns.keys()) {
      if (runId) {
        candidates.add(runId);
      }
    }

    const fileRuns = this._outputFiles.getFiles(stream);
    for (const runId of fileRuns.keys()) {
      if (runId) {
        candidates.add(runId);
      }
    }

    const missingRuns = this._outputFiles.getMissingOutputs(stream);
    for (const runId of missingRuns.keys()) {
      if (runId) {
        candidates.add(runId);
      }
    }

    const usageRuns = this._usageStats.getRunUsage(stream);
    for (const runId of usageRuns.keys()) {
      if (runId) {
        candidates.add(runId);
      }
    }

    const groups = this._taskGroups.getStreamGroups(stream);
    for (const group of groups.values()) {
      if (!group.parentGroupId) {
        candidates.add(group.id);
      }
    }

    return candidates;
  }

  private findLatestRunId(stream: StreamTabId): string | null {
    const groups = this._taskGroups.getStreamGroups(stream);
    let latest: { id: string; start: number } | null = null;

    for (const group of groups.values()) {
      if (group.parentGroupId) {
        continue;
      }

      const startTime = this.normalizeStartTime(group);
      if (!latest || startTime >= latest.start) {
        latest = { id: group.id, start: startTime };
      }
    }

    return latest?.id ?? null;
  }

  private normalizeStartTime(group: TaskGroup): number {
    if (typeof group.startTime === 'number') {
      return group.startTime;
    }

    if (typeof group.startTime === 'string') {
      const parsed = Date.parse(group.startTime);
      return Number.isNaN(parsed) ? 0 : parsed;
    }

    return 0;
  }

  private loadActiveRunIds(): void {
    const stored = this.storage.get<Record<string, string | null>>(
      WorkspaceStateKey.ACTIVE_RUN_IDS,
      {},
    );

    // Normalize at boundary to ensure branded StorageKey storage
    this._activeRunIds = new Map(
      Object.entries(stored).map(([stream, runId]) => [
        stream,
        runId ? normalizeRunId(runId) : null,
      ]),
    );
  }

  private saveActiveRunIds(): void {
    const serialized = Object.fromEntries(this._activeRunIds.entries());
    void this.storage.update(WorkspaceStateKey.ACTIVE_RUN_IDS, serialized);
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
    this.taskStates.set(streamTabId, cloneTaskState(taskState));
    this.clearStreamHints(streamTabId);
    this.saveTaskStates();
    this.cleanupToolUseAgentRegistry();
  }

  getTaskState(streamTabId: StreamTabId): TaskState | undefined {
    const stored = this.taskStates.get(streamTabId);
    return stored ? cloneTaskState(stored) : undefined;
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
    return new Map(
      Array.from(this.taskStates.entries(), ([stream, state]) => [
        stream,
        cloneTaskState(state),
      ]),
    );
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

  clearExecutionId(streamTabId: StreamTabId): void {
    this._executionIds.delete(streamTabId);
    this.saveExecutionIds();
  }

  // Stream cleanup operations
  async clearStream(stream: StreamTabId): Promise<void> {
    await Promise.all([
      this._streamTabs.delete(stream),
      this._taskGroups.deleteStream(stream),
      this._outputFiles.deleteStream(stream),
      this._usageStats.deleteStream(stream),
      this._runInstructions.clearStream(stream),
    ]);
    const removedState = this.taskStates.delete(stream);
    this._executionIds.delete(stream);
    this.clearStreamHints(stream);
    this.clearActiveRun(stream);
    this.clearTodos(stream);

    // Update active stream if necessary
    if (this._activeStream === stream) {
      const remainingStreams = this._streamTabs.keys();
      this._activeStream = remainingStreams[0] || '';
      this.saveActiveStream();
    }

    if (removedState) {
      this.saveTaskStates();
      this.cleanupToolUseAgentRegistry();
    }
    this.saveExecutionIds();
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
    this._streamHints.clear();
    this._todos.clear();
    this._activeRunIds.clear();
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
    // Load basic state first
    await Promise.all([
      this._streamTabs.load(),
      this._taskGroups.load(),
      this._outputFiles.load(),
      this._usageStats.load(),
      this._runInstructions.load(),
    ]);

    // Load dependent state after basic state is loaded
    await Promise.all([
      this.loadActiveStream(), // Depends on stream tabs being loaded
      this.loadTaskStates(),
      this.loadExecutionIds(),
      this.loadStreamSortOrder(),
      this.loadAgentTypeFilter(),
      this.loadActiveRunIds(),
    ]);
  }

  /**
   * Load active stream from persistence
   */
  private async loadActiveStream(): Promise<void> {
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
   * Load task states from persistence
   */
  private async loadTaskStates(): Promise<void> {
    const raw = await this.loadRecordWithLegacyFallback(
      WorkspaceStateKey.TASK_STATES,
    );

    this.taskStates.clear();

    if (Object.keys(raw).length === 0) {
      this.cleanupToolUseAgentRegistry();
      return;
    }

    const container = raw;
    const buckets: Record<string, unknown>[] = [];

    if (
      typeof container.workflow === 'object' ||
      typeof container.toolUse === 'object'
    ) {
      if (container.workflow && typeof container.workflow === 'object') {
        buckets.push(container.workflow as Record<string, unknown>);
      }
      if (container.toolUse && typeof container.toolUse === 'object') {
        buckets.push(container.toolUse as Record<string, unknown>);
      }
    } else {
      buckets.push(container);
    }

    let migratedLegacyState = false;
    let loaded = 0;

    for (const record of buckets) {
      for (const [stream, rawState] of Object.entries(record)) {
        if (!rawState || typeof rawState !== 'object') {
          continue;
        }

        const state = rawState as TaskState;

        if (!state.session) {
          const agentConfig = (state as { agentConfig?: any }).agentConfig;
          if (!agentConfig || typeof agentConfig !== 'object') {
            continue;
          }

          const session = resolveAgentSessionDescriptor(
            agentConfig.agentType as AgentType | undefined,
            agentConfig.agentCategory as AgentCategory | undefined,
          );

          state.session = session;
          state.agentConfig = { ...agentConfig, session };
          migratedLegacyState = true;
        } else if (!state.agentConfig.session) {
          state.agentConfig = { ...state.agentConfig, session: state.session };
          migratedLegacyState = true;
        }

        this.taskStates.set(stream as StreamTabId, cloneTaskState(state));
        loaded += 1;
      }
    }

    if (loaded > 0) {
      this.logger.debug(`Loaded task states for ${loaded} streams`);
    }

    if (migratedLegacyState) {
      this.saveTaskStates();
    }

    this.cleanupToolUseAgentRegistry();
  }

  /**
   * Load execution IDs from persistence
   */
  private async loadExecutionIds(): Promise<void> {
    const savedIdsRecord = await this.loadRecordWithLegacyFallback(
      WorkspaceStateKey.EXECUTION_IDS,
    );

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

  private async loadRecordWithLegacyFallback(
    key: WorkspaceStateKey,
    legacyRoots: string[] = [],
  ): Promise<Record<string, unknown>> {
    const current = this.storage.get<unknown>(key);
    if (
      current &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      Object.keys(current as Record<string, unknown>).length > 0
    ) {
      return current as Record<string, unknown>;
    }

    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspacePath) {
      for (const root of [key as string, ...legacyRoots]) {
        const legacyKey = `${root}.${workspacePath}`;
        const legacy = this.storage.get<unknown>(legacyKey);
        if (
          legacy &&
          typeof legacy === 'object' &&
          !Array.isArray(legacy) &&
          Object.keys(legacy as Record<string, unknown>).length > 0
        ) {
          await this.storage.update(key, legacy as Record<string, unknown>);
          await this.storage.update(legacyKey, undefined as never);
          return legacy as Record<string, unknown>;
        }
      }
    }

    if (current && typeof current === 'object' && !Array.isArray(current)) {
      return current as Record<string, unknown>;
    }

    return {};
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
    const serialized = Object.fromEntries(
      Array.from(this.taskStates.entries(), ([stream, state]) => [
        stream,
        cloneTaskState(state),
      ]),
    );

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
    const executionIdsObj = Object.fromEntries(this._executionIds.entries());
    void this.storage.update(WorkspaceStateKey.EXECUTION_IDS, executionIdsObj);
  }

  private async loadStreamSortOrder(): Promise<void> {
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

  private async loadAgentTypeFilter(): Promise<void> {
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
