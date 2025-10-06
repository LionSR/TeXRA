// Third-party imports
// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import { WebviewUpdater } from '../managers';

// @ts-ignore - Import JavaScript module
import { STATUS } from '../modules/constants.js';

// Local imports
import { ProgressViewState } from '../state/ProgressViewState';
import { buildStreamInfos } from '../streamInfoUtils';
import type { StreamTabInfo } from '../types';
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';
import type { OutputFileInfo } from '@agent/output/types';
import {
  AgentType,
  AgentSessionKind,
  resolveAgentSessionMetadata,
} from '@agent/core/AgentDataclass';

// Types
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import { bus } from '@eventBus/ProgressEventBus';
import { AgentLogger } from '@logger/AgentLogger';
import { LogMessageData, LogMessageUpdate, TaskGroup } from '@logger/LogTypes';
import { parseLegacyLogData } from '@logger/logUtils';
import { TaskState, isWorkflowTaskState } from '@logger/TaskState';
import { getConfig } from '@utils/config';

// Type aliases for status values
type StatusType =
  | typeof STATUS.RUNNING
  | typeof STATUS.ERROR
  | typeof STATUS.STOPPED
  | typeof STATUS.READY
  | typeof STATUS.WAITING
  | typeof STATUS.RESUMING;
type StreamStatusType =
  | typeof STATUS.RUNNING
  | typeof STATUS.ERROR
  | typeof STATUS.STOPPED
  | typeof STATUS.WAITING
  | typeof STATUS.RESUMING;
type StreamStatusOrReadyType = StreamStatusType | typeof STATUS.READY;

/**
 * Handles progress event bus subscriptions for the progress view.
 * Provides a clean separation between event handling and business logic
 * by delegating to the state manager and webview updater.
 */
export class ProgressEventHandler {
  private readonly logger: AgentLogger;
  private _streamStatus: Map<string, StreamStatusType> = new Map();

  constructor(
    private state: ProgressViewState,
    private webviewUpdater: WebviewUpdater,
  ) {
    this.logger = new AgentLogger('ProgressEventHandler');
  }

  /**
   * Parse legacy JSON content from the log message text when structured data is
   * missing. Parsed results are stored back into the log object so that future
   * lookups don't require re-parsing.
   */
  /**
   * Setup all event bus listeners
   */
  setupEventListeners(): vscode.Disposable[] {
    return [
      new vscode.Disposable(
        bus.on('setActiveStream', this.handleSetActiveStream.bind(this)),
      ),
      new vscode.Disposable(
        bus.on('updateStreamStatus', this.handleUpdateStreamStatus.bind(this)),
      ),
      new vscode.Disposable(
        bus.on('addOutputFiles', this.handleAddOutputFiles.bind(this)),
      ),
      new vscode.Disposable(
        bus.on(
          'updateMissingOutputs',
          this.handleUpdateMissingOutputs.bind(this),
        ),
      ),
      new vscode.Disposable(
        bus.on(
          'clearMissingOutputs',
          this.handleClearMissingOutputs.bind(this),
        ),
      ),
      new vscode.Disposable(
        bus.on('clearOutputFiles', this.handleClearOutputFiles.bind(this)),
      ),
      new vscode.Disposable(
        bus.on('setTaskState', this.handleSetTaskState.bind(this)),
      ),
      new vscode.Disposable(
        bus.on('updateGroupUsage', this.handleUpdateGroupUsage.bind(this)),
      ),
      new vscode.Disposable(
        bus.on('clearTaskOutput', this.handleClearTaskOutput.bind(this)),
      ),
      new vscode.Disposable(
        bus.on('updateStreamUsage', this.handleUpdateStreamUsage.bind(this)),
      ),
      new vscode.Disposable(
        bus.on('addLogMessage', this.handleAddLogMessage.bind(this)),
      ),
      new vscode.Disposable(
        bus.on('updateLogMessage', this.handleUpdateLogMessage.bind(this)),
      ),
      new vscode.Disposable(
        bus.on('addTaskGroup', this.handleAddTaskGroup.bind(this)),
      ),
      new vscode.Disposable(
        bus.on('updateTaskGroup', this.handleUpdateTaskGroup.bind(this)),
      ),
    ];
  }

  /**
   * Handle setting active stream
   */
  private handleSetActiveStream(payload: {
    stream: StreamTabId | null;
    agentType?: AgentType | null;
    agentSessionKind?: AgentSessionKind | null;
  }): void {
    const { stream, agentType, agentSessionKind } = payload;

    if (!stream) {
      return;
    }

    // Ensure the stream exists in streamTabs so it appears in the UI
    // This handles the case where setActiveStream is called before any logs
    this.state.streamTabs.ensureStream(stream);

    const metadata = resolveAgentSessionMetadata(agentType, agentSessionKind);
    this.state.setSessionKindHint(stream, metadata.agentSessionKind);

    const currentFilter = this.state.agentTypeFilter;
    if (
      currentFilter !== 'all' &&
      currentFilter !== metadata.agentSessionKind
    ) {
      this.state.agentTypeFilter = metadata.agentSessionKind;
    }

    this.state.activeStream = stream;

    const status: StreamStatusOrReadyType =
      this._streamStatus.get(stream) ?? STATUS.RUNNING;
    this.handleUpdateStreamStatus({ stream, status });

    if (this.webviewUpdater.isAvailable()) {
      // Update log content (will be empty for new streams)
      this.updateLogContentForStream(stream, { updateInstruction: false });
      this.sendInstructionUpdate(stream);
    }
  }

  /**
   * Handle stream status updates
   */
  private handleUpdateStreamStatus(data: {
    stream: string;
    status: StreamStatusOrReadyType;
  }): void {
    const { stream, status } = data;

    if (status !== STATUS.READY) {
      this._streamStatus.set(stream, status as StreamStatusType);
    } else {
      this._streamStatus.delete(stream);
    }

    if (this.webviewUpdater.isAvailable()) {
      const infos = buildStreamInfos(
        this.state,
        this._streamStatus,
        this.state.agentTypeFilter,
      );
      this.webviewUpdater.updateStreams(
        infos,
        this.state.activeStream,
        this.state.agentTypeFilter,
      );

      if (stream === this.state.activeStream) {
        this.webviewUpdater.updateStatus(status);
      }
    }
  }

  /**
   * Handle adding output files
   */
  private handleAddOutputFiles(data: {
    stream: string;
    filesByRound: { [key: number]: OutputFileInfo[] };
  }): void {
    const { stream, filesByRound } = data;
    this.state.outputFiles.addFiles(stream, filesByRound);

    if (
      this.webviewUpdater.isAvailable() &&
      stream === this.state.activeStream
    ) {
      const files = this.state.outputFiles.getFiles(stream) || {};
      this.webviewUpdater.updateFiles(stream, files);
    }
  }

  /**
   * Handle updating missing outputs
   */
  private handleUpdateMissingOutputs(data: {
    stream: string;
    filesByRound: { [key: number]: string[] };
  }): void {
    const { stream, filesByRound } = data;
    this.state.outputFiles.updateMissingOutputs(stream, filesByRound);

    if (
      this.webviewUpdater.isAvailable() &&
      stream === this.state.activeStream
    ) {
      const missing = this.state.outputFiles.getMissingOutputs(stream) || {};
      this.webviewUpdater.updateMissingOutputs(stream, missing);
    }
  }

  /**
   * Handle clearing missing outputs
   */
  private handleClearMissingOutputs(stream: string): void {
    this.state.outputFiles.clearMissingOutputs(stream);

    if (
      this.webviewUpdater.isAvailable() &&
      stream === this.state.activeStream
    ) {
      this.webviewUpdater.updateMissingOutputs(stream, {});
    }
  }

  /**
   * Handle clearing output files
   */
  private handleClearOutputFiles(stream: string): void {
    this.state.outputFiles.clearFiles(stream);

    if (
      this.webviewUpdater.isAvailable() &&
      stream === this.state.activeStream
    ) {
      this.webviewUpdater.updateFiles(stream, {});
    }
  }

  /**
   * Handle setting task state
   */
  private handleSetTaskState(data: {
    streamTabId: StreamTabId;
    executionId?: ExecutionId;
    taskState: TaskState;
  }): void {
    const { streamTabId, executionId, taskState } = data;

    this.state.setTaskState(streamTabId, taskState);
    this.state.clearSessionKindHint(streamTabId);

    const normalizedState = this.state.getTaskState(streamTabId);

    if (!normalizedState) {
      this.logger.warn(
        `Received setTaskState for ${streamTabId} but no state was stored`,
      );
    } else {
      const sessionKind = resolveAgentSessionMetadata(
        normalizedState.agentType,
        normalizedState.agentSessionKind,
      ).agentSessionKind;
      const currentFilter = this.state.agentTypeFilter;
      const activeStream = this.state.activeStream;

      if (
        activeStream &&
        activeStream === streamTabId &&
        currentFilter !== 'all' &&
        currentFilter !== sessionKind
      ) {
        this.logger.debug(
          `Adjusting agent filter from ${currentFilter} to ${sessionKind} for stream ${streamTabId}`,
        );
        this.state.agentTypeFilter = sessionKind;
      }
    }

    if (executionId) {
      this.state.setExecutionId(streamTabId, executionId);
    }

    if (this.state.activeStream === streamTabId) {
      this.sendInstructionUpdate(streamTabId);
    }

    if (this.webviewUpdater.isAvailable()) {
      const infos = buildStreamInfos(
        this.state,
        this._streamStatus,
        this.state.agentTypeFilter,
      );
      this.webviewUpdater.updateStreams(
        infos,
        this.state.activeStream,
        this.state.agentTypeFilter,
      );
    }
  }

  /**
   * Handle updating group usage
   */
  private handleUpdateGroupUsage(data: {
    stream: string;
    groupId: string;
    usage: TokenUsageStats;
  }): void {
    const { stream, groupId, usage } = data;

    // Update the group with usage information
    const group = this.state.taskGroups.getGroup(stream, groupId);
    if (group) {
      this.state.taskGroups.updateGroup(stream, groupId, { usage });
    }
  }

  /**
   * Handle clearing task output
   */
  private handleClearTaskOutput(streamTabId: StreamTabId): void {
    const taskState = this.state.getTaskState(streamTabId);
    if (!taskState || !isWorkflowTaskState(taskState)) {
      return;
    }

    // Only clear output-related fields, preserve other task state data
    taskState.agentConfig.outputFiles = [];
    taskState.agentConfig.useMultipleOutputs = false;
    taskState.activeFiles.output = false;
    this.state.setTaskState(streamTabId, taskState);
  }

  /**
   * Handle updating stream usage
   */
  private handleUpdateStreamUsage(data: {
    stream: string;
    usage: TokenUsageStats;
  }): void {
    const { stream, usage } = data;
    this.state.usageStats.updateStreamUsage(stream, usage);

    if (
      this.webviewUpdater.isAvailable() &&
      stream === this.state.activeStream
    ) {
      this.webviewUpdater.updateUsage(usage);
    }
  }

  /**
   * Handle adding log message
   */
  private handleAddLogMessage(data: {
    stream: string;
    logMessage: LogMessageData;
  }): void {
    const { stream, logMessage } = data;

    parseLegacyLogData(logMessage, this.logger);

    // Skip debug messages if debug mode is disabled
    if (
      logMessage.level === 'debug' &&
      !getConfig<boolean>('logger.debugMode', false)
    ) {
      return;
    }

    this.state.streamTabs.addMessage(stream, logMessage);

    if (this.webviewUpdater.isAvailable()) {
      this.webviewUpdater.appendLogMessage(stream, logMessage);
    }
  }

  /**
   * Handle updating log message
   */
  private handleUpdateLogMessage(data: {
    stream: string;
    logMessage: LogMessageUpdate;
  }): void {
    const { stream, logMessage } = data;

    const messages = this.state.streamTabs.get(stream);
    if (!messages) return;

    const existing = messages.find((m) => m.id === logMessage.id);
    if (!existing) return;

    if (logMessage.text !== undefined) {
      existing.text = logMessage.text;
    }
    if (logMessage.messageType !== undefined) {
      existing.messageType = logMessage.messageType;
    }
    if (logMessage.level) {
      existing.level = logMessage.level;
    }
    if (logMessage.timestamp !== undefined) {
      existing.timestamp = logMessage.timestamp;
    }
    if (logMessage.verbose !== undefined) {
      existing.verbose = logMessage.verbose;
    }
    if (logMessage.data !== undefined) {
      existing.data = logMessage.data;
    } else {
      // Re-parse the updated text even if existing data is present
      parseLegacyLogData(existing, this.logger, true);
    }

    this.state.streamTabs.save();

    if (
      this.webviewUpdater.isAvailable() &&
      stream === this.state.activeStream
    ) {
      this.webviewUpdater.updateLogMessage(stream, existing);
    }
  }

  /**
   * Handle adding task group
   */
  private handleAddTaskGroup(data: {
    stream: string;
    groupId: string;
    groupName: string;
    startTime: number;
    status: StatusType;
    endTime?: number;
    parentGroupId?: string;
  }): void {
    const {
      stream,
      groupId,
      groupName,
      startTime,
      status,
      endTime,
      parentGroupId,
    } = data;

    // Ensure the stream exists
    if (!this.state.streamTabs.has(stream)) {
      this.logger.debug(`Creating stream from addTaskGroup: ${stream}`);
      if (!this._streamStatus.has(stream)) {
        this.handleUpdateStreamStatus({ stream, status: STATUS.RUNNING });
      }
      this.handleSetActiveStream({ stream });
    }

    const group: TaskGroup = {
      id: groupId,
      name: groupName,
      startTime,
      endTime,
      status,
      parentGroupId,
    };

    this.state.taskGroups.addGroup(stream, groupId, group);

    // Send webview update for the active stream
    if (
      this.webviewUpdater.isAvailable() &&
      stream === this.state.activeStream
    ) {
      this.webviewUpdater.addTaskGroup(stream, group);
    }
  }

  /**
   * Handle updating task group
   */
  private handleUpdateTaskGroup(data: {
    stream: string;
    groupId: string;
    status: StatusType;
    endTime?: number;
  }): void {
    const { stream, groupId, status, endTime } = data;

    this.state.taskGroups.updateGroup(stream, groupId, {
      status,
      endTime,
    });

    // Send webview update for the active stream
    if (
      this.webviewUpdater.isAvailable() &&
      stream === this.state.activeStream
    ) {
      this.webviewUpdater.updateTaskGroup(stream, groupId, status, endTime);
    }
  }

  /**
   * Send instruction updates for the provided stream
   */
  private sendInstructionUpdate(stream: StreamTabId | ''): void {
    if (!this.webviewUpdater.isAvailable()) {
      return;
    }

    if (!stream) {
      this.webviewUpdater.clearInstruction('');
      return;
    }

    const taskState = this.state.getTaskState(stream);
    const instructionUpdate = WebviewUpdater.createInstructionUpdate(taskState);

    if (instructionUpdate) {
      this.webviewUpdater.updateInstruction(stream, instructionUpdate);
    } else {
      this.webviewUpdater.clearInstruction(stream);
    }
  }

  /**
   * Update log content for a specific stream
   */
  private updateLogContentForStream(
    stream: string,
    options: { updateInstruction?: boolean } = {},
  ): void {
    if (!this.webviewUpdater.isAvailable()) return;

    const { updateInstruction = true } = options;

    const messages = this.state.streamTabs.get(stream) || [];
    const groups = Array.from(
      this.state.taskGroups.getStreamGroups(stream).values(),
    );
    this.webviewUpdater.updateLogContent(stream, messages, groups);

    // Send output files for current stream
    const files = this.state.outputFiles.getFiles(stream) || {};
    this.webviewUpdater.updateFiles(stream, files);

    // Send missing outputs for current stream
    const missing = this.state.outputFiles.getMissingOutputs(stream) || {};
    this.webviewUpdater.updateMissingOutputs(stream, missing);

    // Send usage for current stream
    const usage = this.state.usageStats.getStreamUsage(stream);
    this.webviewUpdater.updateUsage(usage);

    // Update status for current stream - default to STOPPED when stream exists but no status is set
    const status = this._streamStatus.get(stream) || STATUS.STOPPED;
    this.webviewUpdater.updateStatus(status);

    if (updateInstruction) {
      this.sendInstructionUpdate(stream);
    }
  }

  /**
   * Get current stream status
   */
  getStreamStatus(stream: string): StreamStatusType | undefined {
    return this._streamStatus.get(stream);
  }

  /**
   * Set the status for a specific stream synchronously.
   */
  setStreamStatus(stream: string, status: StreamStatusOrReadyType): void {
    this.handleUpdateStreamStatus({ stream, status });
  }

  /**
   * Get a copy of all stream statuses
   */
  getAllStreamStatuses(): Map<string, StreamStatusType> {
    return new Map(this._streamStatus);
  }

  /**
   * Mark all running tasks as cancelled (used during restart)
   */
  markAllRunningTasksAsCancelled(): void {
    for (const [stream, status] of this._streamStatus.entries()) {
      if (status === STATUS.RUNNING) {
        this._streamStatus.set(stream, STATUS.STOPPED);
      }
    }
  }

  /**
   * Reset running tasks to ERROR status (used during webview reload)
   * Returns the list of affected streams for further processing
   */
  resetRunningTasksToError(waitingStreams?: Set<string>): string[] {
    const affectedStreams: string[] = [];
    const waitingSet = waitingStreams ?? new Set<string>();

    for (const [stream, status] of this._streamStatus.entries()) {
      if (status === STATUS.RUNNING) {
        if (waitingSet.has(stream)) {
          this._streamStatus.set(stream, STATUS.WAITING);
          this.logger.debug(
            `Stream ${stream} restored to WAITING after reload`,
          );
        } else {
          this._streamStatus.set(stream, STATUS.ERROR);
          affectedStreams.push(stream);
          this.logger.debug(
            `Stream ${stream} set to ERROR due to webview reload`,
          );
        }
      }
    }

    return affectedStreams;
  }
}
