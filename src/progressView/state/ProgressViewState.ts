// Local imports - progress view
import {
  StreamTabsManager,
  TaskGroupManager,
  OutputFilesManager,
  UsageStatsManager,
  TaskStateManager,
} from '../managers';
// Local imports
import { StatePersistenceManager } from '../persistence/StatePersistenceManager';
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import type { AgentFilter } from '../types';
import { STATUS } from '../modules/constants.js';
// Local imports - agent types
import { isAgentTypeFilter } from '@agent/types/AgentStreamTypes';
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { StreamStatusOrReadyType, StreamStatusType } from '../events/types';

// Types
import {
  TaskState,
  isToolUseTaskState,
  isWorkflowTaskState,
} from '@logger/TaskState';
import { getConfig, agentConfigToTaskState } from '@utils/config';
// Local imports - agents
import { cleanupInactiveAgents } from '@agent/toolUse/ToolUseAgentRegistry';

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
  private _activeStream: StreamTabId = '';
  private _streamSortOrder = 'time';
  private _agentTypeFilter: AgentFilter = 'all';
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
  private readonly taskStates: TaskStateManager;
  private readonly streamStatuses = new Map<StreamTabId, StreamStatusType>();
  private readonly persistence: StatePersistenceManager;
  private readonly logger: AgentLogger;

  constructor(persistence: StatePersistenceManager) {
    this.persistence = persistence;
    this.logger = new AgentLogger('ProgressViewState');
    this.taskStates = new TaskStateManager();

    // Initialize focused managers
    this._streamTabs = new StreamTabsManager(persistence);
    this._taskGroups = new TaskGroupManager(persistence);
    this._outputFiles = new OutputFilesManager(persistence);
    this._usageStats = new UsageStatsManager(persistence);
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

  getStreamStatus(stream: StreamTabId): StreamStatusType | undefined {
    return this.streamStatuses.get(stream);
  }

  setStreamStatus(
    stream: StreamTabId,
    status: StreamStatusOrReadyType,
  ): void {
    if (status === STATUS.READY) {
      this.streamStatuses.delete(stream);
    } else {
      this.streamStatuses.set(stream, status);
    }
  }

  getAllStreamStatuses(): Map<StreamTabId, StreamStatusType> {
    return new Map(this.streamStatuses);
  }

  resetRunningStatuses(waitingStreams?: Set<string>): StreamTabId[] {
    const affected = new Set<StreamTabId>();

    for (const [stream, status] of this.streamStatuses.entries()) {
      if (status === STATUS.RUNNING) {
        if (waitingStreams?.has(stream)) {
          this.streamStatuses.set(stream, STATUS.WAITING);
        } else {
          this.streamStatuses.set(stream, STATUS.ERROR);
          affected.add(stream);
        }
      }
    }

    for (const stream of this._taskGroups.markRunningGroupsErrored(Date.now())) {
      affected.add(stream);
    }

    return Array.from(affected);
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
    const canonical = agentConfigToTaskState(taskState.agentConfig);
    const normalized = structuredClone(canonical);

    normalized.session = structuredClone(
      taskState.session ?? canonical.session,
    );

    if (isWorkflowTaskState(normalized) && isWorkflowTaskState(taskState)) {
      normalized.activeFiles = structuredClone(taskState.activeFiles);
    }

    if (isToolUseTaskState(normalized) && isToolUseTaskState(taskState)) {
      normalized.toolSessionState = taskState.toolSessionState
        ? structuredClone(taskState.toolSessionState)
        : undefined;
    }

    this.clearSessionKindHint(streamTabId);
    this.taskStates.set(streamTabId, normalized);
    this.saveTaskStates();
    this.cleanupToolUseAgentRegistry();
  }

  getTaskState(streamTabId: StreamTabId): TaskState | undefined {
    return this.taskStates.get(streamTabId);
  }

  clearTaskState(streamTabId: StreamTabId): void {
    this.taskStates.delete(streamTabId);
    this.clearSessionKindHint(streamTabId);
    this.saveTaskStates();
    this.cleanupToolUseAgentRegistry();
  }

  getAllTaskStates(): Map<StreamTabId, TaskState> {
    return this.taskStates.cloneAll();
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
  clearStream(stream: StreamTabId): void {
    this._streamTabs.delete(stream);
    this._taskGroups.deleteStream(stream);
    this._outputFiles.deleteStream(stream);
    this._usageStats.deleteStream(stream);
    this.taskStates.delete(stream);
    this._executionIds.delete(stream);
    this.clearSessionKindHint(stream);
    this.streamStatuses.delete(stream);
    this.cleanupToolUseAgentRegistry();

    // Update active stream if necessary
    if (this._activeStream === stream) {
      const remainingStreams = this._streamTabs.keys();
      this._activeStream = remainingStreams[0] || '';
      this.saveActiveStream();
    }

    this.saveTaskStates();
    this.saveExecutionIds();
  }

  // Stream content erasure (clear content but keep the stream tab and re-run capability)
  eraseStreamContent(stream: StreamTabId): void {
    // Clear visual content but keep the stream tab
    this._streamTabs.clearContent(stream);

    // Clear display-related data (matching original eraseStream behavior)
    this._taskGroups.deleteStream(stream);
    this._outputFiles.deleteStream(stream);
    this.clearSessionKindHint(stream);

    // NOTE: Preserve taskStates and executionIds - these are needed for re-run functionality
    // NOTE: Preserve usageStats - these were not cleared in original implementation
    // NOTE: Missing outputs are also preserved (not cleared in original)
  }

  clearAll(): void {
    this._streamTabs.clear();
    this._taskGroups.clear();
    this._outputFiles.clear();
    this._usageStats.clear();
    this.taskStates.clear();
    this._executionIds.clear();
    this._sessionCategoryHints.clear();
    this.streamStatuses.clear();
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
    const savedActiveStream = await this.persistence.load<string>(
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
    const savedTaskStates = await this.persistence.load<
      Record<string, TaskState>
    >(WorkspaceStateKey.TASK_STATES, {});

    this.taskStates.setAll(savedTaskStates ?? {});

    const totalStates = this.taskStates.size();
    if (totalStates > 0) {
      this.logger.debug(`Loaded task states for ${totalStates} streams`);
    }

    this.cleanupToolUseAgentRegistry();
  }

  /**
   * Load execution IDs from persistence
   */
  private async loadExecutionIds(): Promise<void> {
    const savedIds = await this.persistence.load<{
      [key: string]: string;
    }>(WorkspaceStateKey.EXECUTION_IDS, {});

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
    this.persistence.save(
      WorkspaceStateKey.ACTIVE_STREAM_TAB,
      this._activeStream,
    );
  }

  /**
   * Save task states to persistence
   */
  private saveTaskStates(): void {
    this.persistence.save(
      WorkspaceStateKey.TASK_STATES,
      this.taskStates.toObject(),
    );
  }

  private cleanupToolUseAgentRegistry(): void {
    cleanupInactiveAgents(this.taskStates.getActiveToolUseStreams());
  }

  /**
   * Save execution IDs to persistence
   */
  private saveExecutionIds(): void {
    const executionIdsObj = Object.fromEntries(this._executionIds.entries());
    this.persistence.save(WorkspaceStateKey.EXECUTION_IDS, executionIdsObj);
  }

  private async loadStreamSortOrder(): Promise<void> {
    const configDefault = getConfig(
      'texra.progressBoard.streamSortOrder',
      'time',
    );
    this._streamSortOrder = await this.persistence.load(
      WorkspaceStateKey.STREAM_SORT_ORDER,
      configDefault,
    );
  }

  private saveStreamSortOrder(): void {
    this.persistence.save(
      WorkspaceStateKey.STREAM_SORT_ORDER,
      this._streamSortOrder,
    );
  }

  private async loadAgentTypeFilter(): Promise<void> {
    const savedFilter = await this.persistence.load<string>(
      WorkspaceStateKey.STREAM_AGENT_FILTER,
      'all',
    );
    this._agentTypeFilter = isAgentTypeFilter(savedFilter)
      ? savedFilter
      : 'all';
  }

  private saveAgentTypeFilter(): void {
    this.persistence.save(
      WorkspaceStateKey.STREAM_AGENT_FILTER,
      this._agentTypeFilter,
    );
  }
}
