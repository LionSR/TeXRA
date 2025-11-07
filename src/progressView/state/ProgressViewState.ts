// Local imports - progress view
import {
  StreamTabsManager,
  TaskGroupManager,
  OutputFilesManager,
  UsageStatsManager,
} from '../managers';
import type { StateStorage } from '../persistence/PersistentMapManager';
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';
import { workspaceSM, WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import type { AgentFilter } from '../types';
// Local imports - agent types
import { isAgentTypeFilter } from '@agent/types/AgentStreamTypes';
import { AgentCategory } from '@agent/core/AgentDataclass';

// Types
import {
  TaskState,
  isToolUseTaskState,
  isWorkflowTaskState,
} from '@logger/TaskState';
import { getConfig } from '@utils/config';
// Local imports - agents
import { cleanupInactiveAgents } from '@agent/toolUse/ToolUseAgentRegistry';

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
  private _activeStream: StreamTabId = '';
  private _streamSortOrder = 'time';
  private _agentTypeFilter: AgentFilter = 'all';
  private readonly taskStates = new Map<StreamTabId, TaskState>();
  private _executionIds: Map<StreamTabId, ExecutionId> = new Map();
  /**
   * Ephemeral session-kind hints keyed by stream ID.
   *
   * When a stream becomes active before its {@link TaskState} is persisted,
   * progress events populate this map so the UI can immediately classify the
   * tab as workflow vs. tool-use. Once canonical metadata is stored the entry
   * is cleared, so there is no need to persist these hints across sessions.
   */
  private _sessionCategoryHints: Map<StreamTabId, AgentCategory> = new Map();
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
  get activeStream(): StreamTabId {
    return this._activeStream;
  }

  set activeStream(stream: StreamTabId) {
    this._activeStream = stream;
    this.saveActiveStream();
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

  // Session kind hint management (non-persistent)
  setSessionKindHint(
    streamTabId: StreamTabId,
    sessionCategory: AgentCategory,
  ): void {
    this._sessionCategoryHints.set(streamTabId, sessionCategory);
  }

  getSessionKindHint(streamTabId: StreamTabId): AgentCategory | undefined {
    return this._sessionCategoryHints.get(streamTabId);
  }

  clearSessionKindHint(streamTabId: StreamTabId): void {
    this._sessionCategoryHints.delete(streamTabId);
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
    this.clearSessionKindHint(streamTabId);
    this.saveTaskStates();
    this.cleanupToolUseAgentRegistry();
  }

  getTaskState(streamTabId: StreamTabId): TaskState | undefined {
    const stored = this.taskStates.get(streamTabId);
    return stored ? cloneTaskState(stored) : undefined;
  }

  clearTaskState(streamTabId: StreamTabId): void {
    const didDelete = this.taskStates.delete(streamTabId);
    this.clearSessionKindHint(streamTabId);
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
    ]);
    const removedState = this.taskStates.delete(stream);
    this._executionIds.delete(stream);
    this.clearSessionKindHint(stream);

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

  // Stream content erasure (clear content but keep the stream tab and re-run capability)
  async eraseStreamContent(stream: StreamTabId): Promise<void> {
    // Clear visual content but keep the stream tab
    await this._streamTabs.clearContent(stream);

    // Clear display-related data (matching original eraseStream behavior)
    await Promise.all([
      this._taskGroups.deleteStream(stream),
      this._outputFiles.deleteStream(stream),
    ]);
    this.clearSessionKindHint(stream);

    // NOTE: Preserve taskStates and executionIds - these are needed for re-run functionality
    // NOTE: Preserve usageStats - these were not cleared in original implementation
    // NOTE: Missing outputs are also preserved (not cleared in original)
  }

  async clearAll(): Promise<void> {
    await Promise.all([
      this._streamTabs.clear(),
      this._taskGroups.clear(),
      this._outputFiles.clear(),
      this._usageStats.clear(),
    ]);
    this.taskStates.clear();
    this._executionIds.clear();
    this._sessionCategoryHints.clear();
    this._activeStream = '';
    this.saveActiveStream();
    this.saveTaskStates();
    this.saveExecutionIds();
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
    ]);

    // Load dependent state after basic state is loaded
    await Promise.all([
      this.loadActiveStream(), // Depends on stream tabs being loaded
      this.loadTaskStates(),
      this.loadExecutionIds(),
      this.loadStreamSortOrder(),
      this.loadAgentTypeFilter(),
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
    const raw = this.storage.get<unknown>(WorkspaceStateKey.TASK_STATES, {});

    this.taskStates.clear();

    let loaded = 0;
    const isTaskState = (value: unknown): value is TaskState => {
      if (!value || typeof value !== 'object') {
        return false;
      }
      return (
        isWorkflowTaskState(value as TaskState) ||
        isToolUseTaskState(value as TaskState)
      );
    };

    const addFromRecord = (record: unknown): void => {
      if (!record || typeof record !== 'object') {
        return;
      }

      for (const [stream, value] of Object.entries(
        record as Record<string, unknown>,
      )) {
        if (!isTaskState(value)) {
          continue;
        }

        this.taskStates.set(stream as StreamTabId, cloneTaskState(value));
        loaded += 1;
      }
    };

    let migratedLegacyState = false;

    if (raw && typeof raw === 'object') {
      const container = raw as Record<string, unknown>;
      const workflow = container['workflow'];
      const toolUse = container['toolUse'];

      const hasLegacyShape =
        (!!workflow &&
          typeof workflow === 'object' &&
          !isTaskState(workflow)) ||
        (!!toolUse && typeof toolUse === 'object' && !isTaskState(toolUse));

      if (hasLegacyShape) {
        migratedLegacyState = true;
        addFromRecord(workflow);
        addFromRecord(toolUse);
      } else {
        addFromRecord(container);
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
    const savedIds = this.storage.get<Record<string, ExecutionId>>(
      WorkspaceStateKey.EXECUTION_IDS,
      {},
    );

    if (savedIds && Object.keys(savedIds).length > 0) {
      this._executionIds = new Map(Object.entries(savedIds));
      this.logger.debug(
        `Loaded execution IDs for ${this._executionIds.size} streams`,
      );
    } else {
      this._executionIds.clear();
    }
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
