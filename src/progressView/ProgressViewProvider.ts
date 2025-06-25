// Third-party imports
import * as vscode from 'vscode';

// Local imports - webview
import { ProgressViewContentProvider } from './ProgressViewContentProvider';
import { ProgressViewMessageHandler } from './ProgressViewMessageHandler';
import { ProgressStateManager } from './ProgressStateManager';

import { TaskState } from '@logger/TaskState';
import { AgentLogger } from '@logger/AgentLogger';

import { getConfig } from '@utils/config';
import { shouldUseConsolidatedChannel } from '@utils/loggerUtils';

import { TokenUsageStats } from '../types/UsageTypes';
import { TaskGroup } from '../logger/LogTypes';
import type { DiffStats } from '../types/DiffTypes';
import { randomUUID } from 'crypto';
import { onProgress } from '@eventBus/ProgressEventBus';

// @ts-ignore - Import JavaScript module
import { STATUS, COMMANDS } from './modules/constants.js';

// Type aliases for status values
type StatusType =
  | typeof STATUS.RUNNING
  | typeof STATUS.ERROR
  | typeof STATUS.STOPPED
  | typeof STATUS.READY;
type StreamStatusType =
  | typeof STATUS.RUNNING
  | typeof STATUS.ERROR
  | typeof STATUS.STOPPED;

interface ColoredLogMessage {
  id: string;
  message: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  timestamp: number;
  groupId?: string;
  messageType?: 'default' | 'scratchpad' | 'thinking';
}

// Channels that should not be persisted in workspace storage

interface OutputFileInfo extends DiffStats {
  path: string;
  base?: string | null;
  prev?: string | null;
  original?: string;
}

export class ProgressViewProvider implements vscode.WebviewViewProvider {
  private static _instance: ProgressViewProvider | undefined;
  private _view?: vscode.WebviewView;
  private readonly _stateManager: ProgressStateManager;
  private readonly _contentProvider: ProgressViewContentProvider;
  private readonly _messageHandler: ProgressViewMessageHandler;
  private _disposables: vscode.Disposable[] = [];
  private readonly _extensionUri: vscode.Uri;
  private readonly _viewTitle: string;
  private _viewDisposables: vscode.Disposable[] = [];
  private _streamStatus: Map<string, StreamStatusType> = new Map();
  private _webviewReady = false;
  private _pendingUpdate = false;
  private readonly logger: AgentLogger;

  constructor(
    private readonly context: vscode.ExtensionContext,
    title: string = 'Tasks',
  ) {
    this._extensionUri = context.extensionUri;
    this._viewTitle = title;
    this._stateManager = new ProgressStateManager();
    this._contentProvider = new ProgressViewContentProvider(context);
    this._messageHandler = new ProgressViewMessageHandler(this);
    // State will be loaded via initialize()
    this.logger = new AgentLogger('ProgressViewProvider');

    // Set instance
    ProgressViewProvider._instance = this;

    // Listen for workspace folder changes
    this._disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        await this._stateManager.loadState();
        this._updateWebview();
      }),
    );
  }

  /**
   * Initialize provider state. Must be called after construction.
   */
  public async initialize(): Promise<void> {
    await this._stateManager.loadState();
    onProgress('setActiveStream', (stream: string) =>
      this.setActiveStream(stream),
    );
    onProgress(
      'updateStreamStatus',
      (p: { stream: string; status: StreamStatusType }) =>
        this.updateStreamStatus(p.stream, p.status),
    );
    onProgress(
      'addOutputFiles',
      (p: { stream: string; filesByRound: { [key: number]: any[] } }) =>
        this.addOutputFiles(p.stream, p.filesByRound),
    );
    onProgress('clearOutputFiles', (stream: string) =>
      this.clearOutputFiles(stream),
    );
    onProgress(
      'setTaskState',
      (p: { streamId: string; taskState: TaskState }) =>
        this.setTaskState(p.streamId, p.taskState),
    );
    onProgress(
      'updateGroupUsage',
      (p: { stream: string; groupId: string; usage: TokenUsageStats }) =>
        this.updateGroupUsage(p.stream, p.groupId, p.usage),
    );
    onProgress('clearTaskOutput', (streamId: string) =>
      this.clearTaskOutput(streamId),
    );
    onProgress(
      'updateStreamUsage',
      (p: { stream: string; usage: TokenUsageStats }) =>
        this.updateStreamUsage(p.stream, p.usage),
    );
    onProgress(
      'addLogMessage',
      (p: {
        stream: string;
        message: string;
        level: 'error' | 'warn' | 'info' | 'debug';
        groupId?: string;
        timestamp: number;
        messageType: 'default' | 'scratchpad' | 'thinking';
        id: string;
      }) =>
        this.addLogMessage(
          p.stream,
          p.message,
          p.level,
          p.groupId,
          p.timestamp,
          p.messageType,
          p.id,
        ),
    );
    onProgress(
      'updateLogMessage',
      (p: {
        stream: string;
        id: string;
        message: string;
        messageType: 'default' | 'scratchpad' | 'thinking';
      }) => this.updateLogMessage(p.stream, p.id, p.message, p.messageType),
    );
    onProgress(
      'addLogGroup',
      (p: {
        stream: string;
        groupId: string;
        groupName: string;
        startTime: number;
        status: StatusType;
        endTime?: number;
        parentGroupId?: string;
      }) =>
        this.addLogGroup(
          p.stream,
          p.groupId,
          p.groupName,
          p.startTime,
          p.status,
          p.endTime,
          p.parentGroupId,
        ),
    );
    onProgress(
      'updateLogGroup',
      (p: {
        stream: string;
        groupId: string;
        status: StatusType;
        endTime?: number;
      }) => this.updateLogGroup(p.stream, p.groupId, p.status, p.endTime),
    );
  }

  public static getInstance(): ProgressViewProvider | undefined {
    return this._instance;
  }

  public dispose() {
    this._disposables.forEach((d) => d.dispose());
    this._cleanupView();
  }

  private _cleanupView() {
    // Dispose of all view-specific disposables
    this._viewDisposables.forEach((d) => d.dispose());
    this._viewDisposables = [];
    this._view = undefined;
    this._webviewReady = false;
    this._pendingUpdate = false;
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    // Clean up old view if it exists
    this._cleanupView();

    this._webviewReady = false;
    this._pendingUpdate = false;

    // Instead of automatically marking running tasks as errors, preserve their status
    // We no longer need to reset running stream statuses - they'll be preserved from storage
    // this._resetRunningStreamStatuses();

    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'src', 'progressView'),
        vscode.Uri.joinPath(this._extensionUri, 'src', 'common', 'styles'),
        vscode.Uri.joinPath(this._extensionUri, 'src', 'common', 'modules'),
        vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'split.js'),
        vscode.Uri.joinPath(
          this._extensionUri,
          'node_modules',
          '@vscode',
          'codicons',
          'dist',
        ),
      ],
    };

    // Set the webview title
    webviewView.title = this._viewTitle;

    // Add visibility change handler
    this._viewDisposables.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this._updateWebview();
        }
      }),
    );

    // Handle theme changes
    this._viewDisposables.push(
      vscode.window.onDidChangeActiveColorTheme(() => {
        if (webviewView.visible) {
          this._updateWebview();
        }
      }),
    );

    // Set initial HTML content
    webviewView.webview.html = this._contentProvider.getHtmlContent(
      webviewView.webview,
    );

    // Initialize webview with current state after webview signals readiness
    this._updateWebview();

    // Handle webview messages
    this._viewDisposables.push(
      webviewView.webview.onDidReceiveMessage(async (message) => {
        if (message.command === COMMANDS.WEBVIEW_READY) {
          this._webviewReady = true;
          if (this._pendingUpdate) {
            this._updateWebview();
          }
          return;
        }
        await this._messageHandler.handleMessage(message, webviewView);
      }),
    );

    // Register disposable for cleanup
    this._viewDisposables.push(
      webviewView.onDidDispose(() => {
        this._cleanupView();
      }),
    );
  }

  private _updateWebview() {
    if (!this._view) {
      return;
    }

    if (!this._webviewReady) {
      this._pendingUpdate = true;
      return;
    }

    const streams = Array.from(this._stateManager.logStreams.keys());

    // Use stored active stream, fallback to first stream if active stream doesn't exist
    if (!streams.includes(this._stateManager.activeStream)) {
      this._stateManager.activeStream = streams[0] ?? '';
    }

    this._view.webview.postMessage({
      command: COMMANDS.UPDATE_STREAMS,
      streams,
      currentStream: this._stateManager.activeStream,
    });
    this.updateLogContent(this._stateManager.activeStream);

    // Send output files for current stream
    const files =
      this._stateManager.outputFiles.get(this._stateManager.activeStream) || {};
    this._view.webview.postMessage({
      command: COMMANDS.UPDATE_FILES,
      stream: this._stateManager.activeStream,
      files,
    });

    const usage = this._stateManager.usageStats.get(
      this._stateManager.activeStream,
    );
    this._view.webview.postMessage({
      command: COMMANDS.UPDATE_USAGE,
      usage,
    });

    // Update status for current stream
    if (this._stateManager.activeStream) {
      const status = this._streamStatus.get(this._stateManager.activeStream);
      if (status) {
        this._view.webview.postMessage({
          command: COMMANDS.UPDATE_STATUS,
          status: status,
        });
      }
    } else {
      // If no active stream, show ready state
      this._view.webview.postMessage({
        command: COMMANDS.UPDATE_STATUS,
        status: STATUS.READY,
      });
    }

    this._pendingUpdate = false;
  }

  public addLogMessage(
    stream: string,
    message: string,
    level: 'error' | 'warn' | 'info' | 'debug' = 'info',
    groupId?: string,
    timestamp: number = Date.now(),
    messageType: 'default' | 'scratchpad' | 'thinking' = 'default',
    id: string = randomUUID(),
  ) {
    // Skip if this stream should be excluded from the progress view
    if (shouldUseConsolidatedChannel(stream)) {
      return;
    }

    // Skip debug messages if debug mode is disabled
    if (level === 'debug' && !getConfig<boolean>('logger.debugMode', false)) {
      return;
    }

    // Create stream if it doesn't exist
    if (!this._stateManager.logStreams.has(stream)) {
      this.logger.debug(`Adding new stream to ProgressView: ${stream}`);
      this._stateManager.logStreams.set(stream, []);

      // Set initial status to running for new streams
      if (!this._streamStatus.has(stream)) {
        this.updateStreamStatus(stream, STATUS.RUNNING);
      }

      // Auto-focus new agent streams - make this stream the active one
      this.setActiveStream(stream);

      if (this._view) {
        if (this._view.visible) {
          // Keep focus on the ProgressBoard if it's already visible
          this._view.show(true);
          this.logger.debug(`Auto-focused to new stream: ${stream}`);
        }
      } else {
        // If the view doesn't exist yet, create it without forcing focus
        this.logger.debug(
          `View not yet created, showing progress view panel for stream: ${stream}`,
        );
        vscode.commands.executeCommand('texra.showProgressView');
      }
    }

    const logMessage: ColoredLogMessage = {
      id,
      message,
      level,
      timestamp,
      groupId,
      messageType,
    };

    const messages = this._stateManager.logStreams.get(stream)!;
    messages.push(logMessage);

    if (messages.length > 1000) {
      messages.splice(0, messages.length - 1000);
    }

    this._stateManager.saveState();

    if (this._view) {
      this._view.webview.postMessage({
        command: COMMANDS.APPEND_LOG,
        stream: stream,
        logMessage,
      });
    }
  }

  public updateLogMessage(
    stream: string,
    id: string,
    message: string,
    messageType: 'default' | 'scratchpad' | 'thinking' = 'default',
  ): void {
    const messages = this._stateManager.logStreams.get(stream);
    if (!messages) {
      return;
    }
    const existing = messages.find((m) => m.id === id);
    if (!existing) {
      return;
    }
    existing.message = message;
    existing.messageType = messageType;
    this._stateManager.saveState();
    if (this._view && stream === this._stateManager.activeStream) {
      this._view.webview.postMessage({
        command: COMMANDS.UPDATE_LOG,
        stream,
        logMessage: existing,
      });
    }
  }

  public addLogGroup(
    stream: string,
    groupId: string,
    groupName: string,
    startTime: number,
    status: StatusType,
    endTime?: number,
    parentGroupId?: string,
  ) {
    // Skip if this stream should be excluded from the progress view
    if (shouldUseConsolidatedChannel(stream)) {
      return;
    }

    // Ensure the stream exists so the UI can create a new tab immediately
    // this seems to be the fix for the issue where the progress view panel is not shown when a new stream is created
    if (!this._stateManager.logStreams.has(stream)) {
      this.logger.debug(`Creating stream from addLogGroup: ${stream}`);
      this._stateManager.logStreams.set(stream, []);
      if (!this._streamStatus.has(stream)) {
        this.updateStreamStatus(stream, STATUS.RUNNING);
      }
      this.setActiveStream(stream);
      if (this._view) {
        if (this._view.visible) {
          this._view.show(true);
        }
      }
    }

    // Create stream groups mapping if it doesn't exist
    if (!this._stateManager.taskGroups.has(stream)) {
      this._stateManager.taskGroups.set(stream, new Map());
    }

    const streamGroups = this._stateManager.taskGroups.get(stream)!;
    streamGroups.set(groupId, {
      id: groupId,
      name: groupName,
      startTime,
      endTime,
      status,
      parentGroupId,
    });

    this._stateManager.saveState();

    if (this._view && stream === this._stateManager.activeStream) {
      this._view.webview.postMessage({
        command: COMMANDS.ADD_LOG_GROUP,
        stream,
        group: {
          id: groupId,
          name: groupName,
          startTime,
          endTime,
          status,
          parentGroupId,
        },
      });
    }
  }

  public updateLogGroup(
    stream: string,
    groupId: string,
    status: StatusType,
    endTime?: number,
  ) {
    // Skip if this stream should be excluded from the progress view
    if (shouldUseConsolidatedChannel(stream)) {
      return;
    }

    const streamGroups = this._stateManager.taskGroups.get(stream);
    if (!streamGroups) {
      return;
    }

    const group = streamGroups.get(groupId);
    if (!group) {
      return;
    }

    group.status = status;
    if (endTime) {
      group.endTime = endTime;
    }

    this._stateManager.saveState();

    if (this._view && stream === this._stateManager.activeStream) {
      this._view.webview.postMessage({
        command: COMMANDS.UPDATE_LOG_GROUP,
        stream,
        groupId,
        status,
        endTime,
      });
    }
  }

  public updateLogContent(stream: string) {
    if (!this._view) {
      return;
    }

    // If no stream is provided or stream doesn't exist, use the first available stream
    if (!stream || !this._stateManager.logStreams.has(stream)) {
      const streams = Array.from(this._stateManager.logStreams.keys());
      stream = streams[0] ?? '';
    }

    if (!this._stateManager.logStreams.has(stream)) {
      return;
    }

    const messages = this._stateManager.logStreams.get(stream)!;
    // Filter debug messages if debug mode is disabled
    const displayMessages = getConfig<boolean>('logger.debugMode', false)
      ? messages
      : messages.filter((msg) => msg.level !== 'debug');

    // Get groups for this stream
    const groups = this._stateManager.taskGroups.get(stream) || new Map();

    this._view.webview.postMessage({
      command: COMMANDS.UPDATE_LOGS,
      stream: stream,
      messages: displayMessages,
      groups: Array.from(groups.values()),
    });

    // Send current status for the stream
    const status = this._streamStatus.get(stream) || STATUS.STOPPED;
    this._view.webview.postMessage({
      command: COMMANDS.UPDATE_STATUS,
      status: status,
    });

    // Send output files for this stream
    const files = this._stateManager.outputFiles.get(stream) || {};
    this._view.webview.postMessage({
      command: COMMANDS.UPDATE_FILES,
      stream: stream,
      files,
    });
  }

  public getLogStreams(): Map<string, ColoredLogMessage[]> {
    return this._stateManager.logStreams;
  }

  public getTaskGroups(): Map<string, Map<string, TaskGroup>> {
    return this._stateManager.taskGroups;
  }

  public eraseStream(stream: string) {
    if (this._stateManager.logStreams.has(stream)) {
      this._stateManager.logStreams.get(stream)!.length = 0;
      this._stateManager.taskGroups.delete(stream);
      this._stateManager.outputFiles.delete(stream);
      this._stateManager.saveState();
      this.updateLogContent(stream);
    }
  }

  public deleteAllStreams() {
    this._stateManager.clearAll();
    this._stateManager.saveState();
    if (this._view) {
      this._view.webview.postMessage({ command: COMMANDS.CLEAR_LOGS });
      this._updateWebview();
    }
  }

  public deleteStream(stream: string) {
    if (this._stateManager.logStreams.has(stream)) {
      const streams = Array.from(this._stateManager.logStreams.keys());

      // Case: This is the last stream - erase it first
      if (streams.length === 1) {
        this.eraseStream(stream);
      }

      // Remove the stream from collections
      this._stateManager.clearStream(stream);

      // If the deleted stream was the active one, switch to another stream if available
      if (stream === this._stateManager.activeStream) {
        const remainingStreams = Array.from(
          this._stateManager.logStreams.keys(),
        );
        this._stateManager.activeStream = remainingStreams[0] ?? '';
      }

      this._stateManager.saveState();
      this._updateWebview();
    }
  }

  public updateStreamStatus(stream: string, status: StreamStatusType) {
    // Don't track status for excluded streams
    if (shouldUseConsolidatedChannel(stream)) {
      return;
    }

    if (!this._stateManager.logStreams.has(stream)) {
      return;
    }

    this._streamStatus.set(stream, status);
    if (this._view && stream === this._stateManager.activeStream) {
      this._view.webview.postMessage({
        command: COMMANDS.UPDATE_STATUS,
        status: status,
      });
    }
  }

  public getStreamStatus(stream: string): StreamStatusType | undefined {
    return this._streamStatus.get(stream);
  }

  public addOutputFiles(
    stream: string,
    filesByRound: { [key: number]: OutputFileInfo[] },
  ): void {
    const existing = this._stateManager.outputFiles.get(stream) || {};
    const merged = { ...existing, ...filesByRound };
    this._stateManager.outputFiles.set(stream, merged);
    this._stateManager.saveState();
    if (this._view && stream === this._stateManager.activeStream) {
      this._view.webview.postMessage({
        command: COMMANDS.UPDATE_FILES,
        stream,
        files: merged,
      });
    }
  }

  public getOutputFiles(
    stream: string,
  ): { [key: number]: OutputFileInfo[] } | undefined {
    return this._stateManager.outputFiles.get(stream);
  }

  public clearOutputFiles(stream: string): void {
    if (this._stateManager.outputFiles.has(stream)) {
      this._stateManager.outputFiles.delete(stream);
      this._stateManager.saveState();
      if (this._view && stream === this._stateManager.activeStream) {
        this._view.webview.postMessage({
          command: COMMANDS.UPDATE_FILES,
          stream,
          files: {},
        });
      }
    }
  }

  public updateStreamUsage(stream: string, usage: TokenUsageStats): void {
    this._stateManager.usageStats.set(stream, usage);
    this._stateManager.saveState();
    if (this._view && stream === this._stateManager.activeStream) {
      this._view.webview.postMessage({
        command: COMMANDS.UPDATE_USAGE,
        usage,
      });
    }
  }

  public updateGroupUsage(
    stream: string,
    groupId: string,
    usage: TokenUsageStats,
  ): void {
    const streamGroups = this._stateManager.taskGroups.get(stream);
    if (streamGroups) {
      const group = streamGroups.get(groupId);
      if (group) {
        group.usage = usage;
        this._stateManager.saveState();

        // Notify frontend about group usage update
        if (this._view && stream === this._stateManager.activeStream) {
          this._view.webview.postMessage({
            command: COMMANDS.UPDATE_GROUP_USAGE,
            stream,
            groupId,
            usage,
          });
        }
      }
    }
  }

  public getStreamUsage(stream: string): TokenUsageStats | undefined {
    return this._stateManager.usageStats.get(stream);
  }

  public setActiveStream(stream: string) {
    if (this._stateManager.logStreams.has(stream)) {
      this._stateManager.activeStream = stream;
      this._stateManager.saveState();
      this._updateWebview();
    }
  }

  public setTaskState(streamId: string, taskState: TaskState): void {
    this.logger.debug(`Setting taskState for stream: ${streamId}`);
    // this.logger.debug(`Task state: ${JSON.stringify(taskState)}`);
    this._stateManager.taskStates.set(streamId, taskState);
    this.saveTaskStates();
    this.logger.debug(
      `Current taskStates: ${JSON.stringify(Array.from(this._stateManager.taskStates.entries()))}`,
    );
  }

  public getTaskState(streamId: string): TaskState | undefined {
    this.logger.debug(`Getting taskState for stream: ${streamId}`);
    const taskState = this._stateManager.taskStates.get(streamId);
    if (!taskState) {
      this.logger.warn(`No taskState found for stream: ${streamId}`);
    } else {
      this.logger.debug(`Found taskState: ${JSON.stringify(taskState)}`);
    }
    return taskState;
  }

  /**
   * Clears output file information from the stored task state
   * @param streamId Stream identifier
   */
  public clearTaskOutput(streamId: string): void {
    const state = this._stateManager.taskStates.get(streamId);
    if (state) {
      state.outputFiles = [];
      if (state.activeFiles) {
        state.activeFiles.output = false;
      }
      this._stateManager.taskStates.set(streamId, state);
      this.saveTaskStates();
    }
  }

  private saveTaskStates(): void {
    // this.logger.debug('Saving taskStates to workspace state');
    // Delegate to state manager
    this._stateManager.saveState();
  }

  /**
   * Marks all running tasks as cancelled when extension is deactivated
   */
  public markAllRunningTasksAsCancelled(): void {
    console.log(
      'Marking all running tasks as cancelled due to extension deactivation',
    );

    // Find all running streams
    const runningStreams = Array.from(this._streamStatus.entries())
      .filter(([_, status]) => status === STATUS.RUNNING)
      .map(([streamId]) => streamId);

    if (runningStreams.length === 0) {
      console.log('No running tasks found to cancel');
      return;
    }

    // Set end time for all groups
    const endTime = Date.now();
    const STATUS_CANCELLED = STATUS.ERROR;

    // Update each running stream
    for (const streamId of runningStreams) {
      // Mark stream as cancelled
      this._streamStatus.set(streamId, STATUS_CANCELLED);
      this.addLogMessage(
        streamId,
        'Task cancelled due to extension deactivation.',
        'warn',
        undefined,
        Date.now(),
        'default',
      );

      // Update all active groups for this stream
      const streamGroups = this._stateManager.taskGroups.get(streamId);
      if (streamGroups) {
        const activeGroups = Array.from(streamGroups.entries()).filter(
          ([_, group]) => !group.endTime || group.status === STATUS.RUNNING,
        );

        for (const [groupId, group] of activeGroups) {
          this.updateLogGroup(streamId, groupId, STATUS_CANCELLED, endTime);
        }
      }
    }

    // Save state
    this._stateManager.saveState();
    this.logger.debug(
      `Cancellation complete. Updated ${runningStreams.length} running tasks.`,
    );
  }

  /**
   * Cleans up any tasks with inconsistent states after extension restart
   */
  public cleanupTasksAfterRestart(): void {
    this.logger.debug(
      'Checking for inconsistent task states after extension restart',
    );

    const STATUS_INTERRUPTED = STATUS.ERROR;
    const endTime = Date.now();
    let updatedStreams = 0;
    let updatedGroups = 0;

    // Check all streams for inconsistencies
    for (const streamId of this._stateManager.logStreams.keys()) {
      let wasUpdated = false;

      // Check if stream is running and mark as interrupted
      if (this._streamStatus.get(streamId) === STATUS.RUNNING) {
        this._streamStatus.set(streamId, STATUS_INTERRUPTED);
        this.addLogMessage(
          streamId,
          'Task was interrupted due to extension restart.',
          'warn',
          undefined,
          Date.now(),
          'default',
        );
        wasUpdated = true;
        updatedStreams++;
      }

      // Check for running groups that need to be marked as interrupted
      const streamGroups = this._stateManager.taskGroups.get(streamId);
      if (streamGroups) {
        const activeGroups = Array.from(streamGroups.entries()).filter(
          ([_, group]) => !group.endTime || group.status === STATUS.RUNNING,
        );

        if (activeGroups.length > 0) {
          // Log inconsistent state if stream wasn't running but has running groups
          if (!wasUpdated) {
            this.addLogMessage(
              streamId,
              `Found inconsistent state: stream status is ${this._streamStatus.get(streamId)} but has running groups.`,
              'warn',
              undefined,
              Date.now(),
              'default',
            );
            updatedStreams++;
          }

          // Mark all active groups as interrupted
          for (const [groupId, group] of activeGroups) {
            this.updateLogGroup(streamId, groupId, STATUS_INTERRUPTED, endTime);
            updatedGroups++;
          }
        }
      }
    }

    // Save state
    this._stateManager.saveState();
    this.logger.debug(
      `Cleanup complete. Updated ${updatedStreams} streams and ${updatedGroups} groups.`,
    );
  }

  /**
   * Checks if the progress view panel is currently visible
   * @returns boolean indicating if the view is visible
   */
  public isViewVisible(): boolean {
    return !!this._view && this._view.visible;
  }
}
