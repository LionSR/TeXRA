// Local imports - progress view
import {
  StreamTabsManager,
  TaskGroupManager,
  OutputFilesManager,
  UsageStatsManager,
  ToolUseTaskStateManager,
} from '../managers';
// Local imports
import { StatePersistenceManager } from '../persistence/StatePersistenceManager';
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import type { AgentFilter } from '../types';
// Local imports - agent types
import { isAgentTypeFilter } from '@agent/types/AgentStreamTypes';
import {
  AgentSessionKind,
  resolveAgentSessionMetadata,
} from '@agent/core/AgentDataclass';

// Types
import {
  TaskState,
  isToolUseTaskState,
  isWorkflowTaskState,
  type ToolUseTaskState,
  type WorkflowTaskState,
} from '@logger/TaskState';
import {
  objectToTaskState,
  getConfig,
  agentConfigToTaskState,
} from '@utils/config';

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
  private _workflowTaskStates: Map<StreamTabId, WorkflowTaskState> = new Map();
  private _executionIds: Map<StreamTabId, ExecutionId> = new Map();
  /**
   * Ephemeral session-kind hints keyed by stream ID.
   *
   * When a stream becomes active before its {@link TaskState} is persisted,
   * progress events populate this map so the UI can immediately classify the
   * tab as workflow vs. tool-use. Once canonical metadata is stored the entry
   * is cleared, so there is no need to persist these hints across sessions.
   */
  private _sessionKindHints: Map<StreamTabId, AgentSessionKind> = new Map();
  private readonly toolUseTaskStates: ToolUseTaskStateManager;
  private readonly persistence: StatePersistenceManager;
  private readonly logger: AgentLogger;

  constructor(persistence: StatePersistenceManager) {
    this.persistence = persistence;
    this.logger = new AgentLogger('ProgressViewState');
    this.toolUseTaskStates = new ToolUseTaskStateManager();

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
    sessionKind: AgentSessionKind,
  ): void {
    this._sessionKindHints.set(streamTabId, sessionKind);
  }

  getSessionKindHint(streamTabId: StreamTabId): AgentSessionKind | undefined {
    return this._sessionKindHints.get(streamTabId);
  }

  clearSessionKindHint(streamTabId: StreamTabId): void {
    this._sessionKindHints.delete(streamTabId);
  }

  // Task state management
  setTaskState(streamTabId: StreamTabId, taskState: TaskState): void {
    const metadata = resolveAgentSessionMetadata(
      taskState.agentType,
      taskState.agentSessionKind,
    );
    const normalizedState = agentConfigToTaskState(
      taskState.agentConfig,
      metadata,
    );

    if (isWorkflowTaskState(normalizedState) && 'activeFiles' in taskState) {
      normalizedState.activeFiles = { ...taskState.activeFiles };
    } else if (
      isToolUseTaskState(normalizedState) &&
      'toolSessionState' in taskState &&
      taskState.toolSessionState
    ) {
      normalizedState.toolSessionState = { ...taskState.toolSessionState };
    }

    this.clearSessionKindHint(streamTabId);
    if (isWorkflowTaskState(normalizedState)) {
      this._workflowTaskStates.set(streamTabId, normalizedState);
      this.toolUseTaskStates.delete(streamTabId);
    } else {
      this.toolUseTaskStates.set(streamTabId, normalizedState);
      this._workflowTaskStates.delete(streamTabId);
    }
    this.saveTaskStates();
  }

  getTaskState(streamTabId: StreamTabId): TaskState | undefined {
    return (
      this._workflowTaskStates.get(streamTabId) ||
      this.toolUseTaskStates.get(streamTabId)
    );
  }

  clearTaskState(streamTabId: StreamTabId): void {
    this._workflowTaskStates.delete(streamTabId);
    this.toolUseTaskStates.delete(streamTabId);
    this.clearSessionKindHint(streamTabId);
    this.saveTaskStates();
  }

  getAllTaskStates(): Map<StreamTabId, TaskState> {
    const combined = new Map<StreamTabId, TaskState>();
    for (const [stream, state] of this._workflowTaskStates.entries()) {
      combined.set(stream, state);
    }
    for (const [stream, state] of this.toolUseTaskStates.entries()) {
      combined.set(stream, state);
    }
    return combined;
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
    this._workflowTaskStates.delete(stream);
    this.toolUseTaskStates.delete(stream);
    this._executionIds.delete(stream);
    this.clearSessionKindHint(stream);

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
    this._workflowTaskStates.clear();
    this.toolUseTaskStates.clear();
    this._executionIds.clear();
    this._sessionKindHints.clear();
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
      | {
          workflow?: Record<string, Record<string, any>>;
          toolUse?: Record<string, Record<string, any>>;
        }
      | { [key: string]: Record<string, any> }
      | [string, Record<string, any>][]
    >(WorkspaceStateKey.TASK_STATES, {});

    this._workflowTaskStates.clear();
    this.toolUseTaskStates.clear();

    const processState = (
      stream: string,
      rawState: Record<string, any>,
    ): void => {
      const taskState = objectToTaskState(rawState);
      if (isWorkflowTaskState(taskState)) {
        this._workflowTaskStates.set(stream, taskState);
      } else if (isToolUseTaskState(taskState)) {
        this.toolUseTaskStates.set(stream, taskState);
      }
    };

    if (!savedTaskStates) {
      return;
    }

    if (Array.isArray(savedTaskStates)) {
      for (const [stream, state] of savedTaskStates) {
        processState(stream, state);
      }
    } else if ('workflow' in savedTaskStates || 'toolUse' in savedTaskStates) {
      const { workflow = {}, toolUse = {} } = savedTaskStates as {
        workflow?: Record<string, Record<string, any>>;
        toolUse?: Record<string, Record<string, any>>;
      };
      for (const [stream, state] of Object.entries(workflow)) {
        processState(stream, state);
      }
      for (const [stream, state] of Object.entries(toolUse)) {
        processState(stream, state);
      }
    } else {
      for (const [stream, state] of Object.entries(savedTaskStates)) {
        processState(stream, state);
      }
    }

    const totalStates =
      this._workflowTaskStates.size + this.toolUseTaskStates.size();
    if (totalStates > 0) {
      this.logger.debug(`Loaded task states for ${totalStates} streams`);
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
    const workflowStates = Object.fromEntries(
      this._workflowTaskStates.entries(),
    );
    const toolUseStates = this.toolUseTaskStates.toObject();
    this.persistence.save(WorkspaceStateKey.TASK_STATES, {
      workflow: workflowStates,
      toolUse: toolUseStates,
    });
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
