// Local imports - progress view
import {
  StreamTabsManager,
  TaskGroupManager,
  OutputFilesManager,
  UsageStatsManager,
} from '../managers';
// Local imports
import { StatePersistenceManager } from '../persistence/StatePersistenceManager';
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { createChannelLogger, type ChannelLogger } from '@logger/logUtils';
import type { AgentFilter } from '../types';
// Local imports - agent types
import { isAgentTypeFilter } from '@agent/types/AgentStreamTypes';
import { deriveAgentSessionKind } from '@agent/core/AgentDataclass';

// Types
import { TaskState } from '@logger/TaskState';
import { objectToTaskState, getConfig } from '@utils/config';

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
  private _taskStates: Map<StreamTabId, TaskState> = new Map();
  private _executionIds: Map<StreamTabId, ExecutionId> = new Map();
  private readonly persistence: StatePersistenceManager;
  private readonly logger: ChannelLogger;

  constructor(persistence: StatePersistenceManager) {
    this.persistence = persistence;
    this.logger = createChannelLogger('ProgressViewState');

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

  // Task state management
  setTaskState(streamTabId: StreamTabId, taskState: TaskState): void {
    const normalizedState: TaskState = {
      ...taskState,
      agentSessionKind:
        taskState.agentSessionKind ??
        deriveAgentSessionKind(taskState.agentType),
    };
    this._taskStates.set(streamTabId, normalizedState);
    this.saveTaskStates();
  }

  getTaskState(streamTabId: StreamTabId): TaskState | undefined {
    return this._taskStates.get(streamTabId);
  }

  clearTaskState(streamTabId: StreamTabId): void {
    this._taskStates.delete(streamTabId);
    this.saveTaskStates();
  }

  getAllTaskStates(): Map<StreamTabId, TaskState> {
    return new Map(this._taskStates);
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
    this._taskStates.delete(stream);
    this._executionIds.delete(stream);

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

    // NOTE: Preserve taskStates and executionIds - these are needed for re-run functionality
    // NOTE: Preserve usageStats - these were not cleared in original implementation
    // NOTE: Missing outputs are also preserved (not cleared in original)
  }

  clearAll(): void {
    this._streamTabs.clear();
    this._taskGroups.clear();
    this._outputFiles.clear();
    this._usageStats.clear();
    this._taskStates.clear();
    this._executionIds.clear();
    this._activeStream = '';
    this.saveActiveStream();
    this.saveTaskStates();
    this.saveExecutionIds();
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
      { [key: string]: Record<string, any> } | [string, Record<string, any>][]
    >(WorkspaceStateKey.TASK_STATES, {});

    if (savedTaskStates) {
      const processedStates = new Map<StreamTabId, TaskState>();

      if (Array.isArray(savedTaskStates)) {
        // Backwards compatibility: convert from array format if encountered
        for (const [stream, state] of savedTaskStates) {
          processedStates.set(stream, objectToTaskState(state));
        }
      } else {
        for (const [stream, state] of Object.entries(savedTaskStates)) {
          processedStates.set(stream, objectToTaskState(state));
        }
      }

      this._taskStates = processedStates;
      this.logger.debug(
        `Loaded task states for ${this._taskStates.size} streams`,
      );
    } else {
      this._taskStates.clear();
    }
  }

  /**
   * Load execution IDs from persistence
   */
  private async loadExecutionIds(): Promise<void> {
    const savedIds = await this.persistence.loadWithMigration<{
      [key: string]: string;
    }>(WorkspaceStateKey.EXECUTION_IDS, WorkspaceStateKey.TASK_IDS, {});

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
    const taskStatesObj = Object.fromEntries(this._taskStates.entries());
    this.persistence.save(WorkspaceStateKey.TASK_STATES, taskStatesObj);
  }

  /**
   * Save execution IDs to persistence
   */
  private saveExecutionIds(): void {
    const executionIdsObj = Object.fromEntries(this._executionIds.entries());
    this.persistence.save(WorkspaceStateKey.EXECUTION_IDS, executionIdsObj);
  }

  private async loadStreamSortOrder(): Promise<void> {
    const configDefault = getConfig('progressBoard.streamSortOrder', 'time');
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
