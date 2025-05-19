// Third-party imports
import * as vscode from 'vscode';

// Local imports - webview
import { ProgressViewContentProvider } from './ProgressViewContentProvider';
import { ProgressViewMessageHandler } from './ProgressViewMessageHandler';
import { TaskState } from '../logger/TaskState';
import { AgentLogger } from '../logger/AgentLogger';
import { getConfig } from '../utils/configUtils';
import { objectToTaskState } from '../utils/configConversion';
import {
  shouldExcludeFromProgressView,
  shouldPersistStream,
} from '../utils/loggerUtils';
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
  message: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  groupId?: string;
}

interface LogGroup {
  id: string;
  name: string;
  startTime: string;
  endTime?: string;
  status: StatusType;
  parentGroupId?: string;
}

// Channels that should not be persisted in workspace storage

export class ProgressViewProvider implements vscode.WebviewViewProvider {
  private static _instance: ProgressViewProvider | undefined;
  private _view?: vscode.WebviewView;
  private _logStreams: Map<string, ColoredLogMessage[]> = new Map();
  private _logGroups: Map<string, Map<string, LogGroup>> = new Map(); // streamId -> groupId -> LogGroup
  private readonly _contentProvider: ProgressViewContentProvider;
  private readonly _messageHandler: ProgressViewMessageHandler;
  private readonly _storageKey = 'texra.logStreams';
  private readonly _groupsStorageKey = 'texra.logGroups';
  private readonly _taskStateKey = 'texra.taskStates';
  private _disposables: vscode.Disposable[] = [];
  private readonly _extensionUri: vscode.Uri;
  private readonly _viewTitle: string;
  private _viewDisposables: vscode.Disposable[] = [];
  private _streamStatus: Map<string, StreamStatusType> = new Map();
  private _activeStream: string = '';
  private readonly _activeStreamKey = 'texra.activeLogStream';
  private _taskStates: Map<string, TaskState> = new Map();
  private readonly logger: AgentLogger;

  constructor(
    private readonly context: vscode.ExtensionContext,
    title: string = 'Tasks',
  ) {
    this._extensionUri = context.extensionUri;
    this._viewTitle = title;
    this._contentProvider = new ProgressViewContentProvider(context);
    this._messageHandler = new ProgressViewMessageHandler(this);
    this._loadState();
    this.logger = new AgentLogger('ProgressViewProvider');

    // Set instance
    ProgressViewProvider._instance = this;

    // Listen for workspace folder changes
    this._disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this._loadState();
        this._updateWebview();
      }),
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
  }

  private _getWorkspaceKey(key: string = this._storageKey): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder ? `${key}.${workspaceFolder.uri.fsPath}` : key;
  }

  private _loadState() {
    const savedState = this.context.workspaceState.get<{
      [key: string]: ColoredLogMessage[];
    }>(this._getWorkspaceKey());
    if (savedState) {
      // Only load channels that should be persisted
      this._logStreams = new Map(
        Object.entries(savedState).filter(([channel]) =>
          shouldPersistStream(channel),
        ),
      );
    } else {
      this._logStreams.clear();
    }

    // Load groups
    const savedGroups = this.context.workspaceState.get<{
      [key: string]: { [groupId: string]: LogGroup };
    }>(this._getWorkspaceKey(this._groupsStorageKey));
    if (savedGroups) {
      this._logGroups = new Map(
        Object.entries(savedGroups)
          .filter(([channel]) => shouldPersistStream(channel))
          .map(([streamId, groups]) => [
            streamId,
            new Map(Object.entries(groups)),
          ]),
      );
    } else {
      this._logGroups.clear();
    }

    // Load active stream
    const savedActiveStream = this.context.workspaceState.get<string>(
      this._activeStreamKey,
    );
    if (savedActiveStream && this._logStreams.has(savedActiveStream)) {
      this._activeStream = savedActiveStream;
    } else {
      this._activeStream = Array.from(this._logStreams.keys())[0] ?? '';
    }

    // Load taskStates
    const savedTaskStates = this.context.workspaceState.get<{
      [key: string]: Record<string, any>;
    }>(this._taskStateKey);
    if (savedTaskStates) {
      this._taskStates = new Map(
        Object.entries(savedTaskStates).map(([stream, state]) => [
          stream,
          objectToTaskState(state),
        ]),
      );
    } else {
      this._taskStates.clear();
    }
  }

  private _saveState() {
    // Only save channels that should be persisted
    const persistentStreams = Array.from(this._logStreams.entries()).filter(
      ([channel]) => shouldPersistStream(channel),
    );
    const stateObj = Object.fromEntries(persistentStreams);
    this.context.workspaceState.update(this._getWorkspaceKey(), stateObj);

    // Save groups
    const persistentGroups = Array.from(this._logGroups.entries())
      .filter(([channel]) => shouldPersistStream(channel))
      .map(([streamId, groups]) => [
        streamId,
        Object.fromEntries(groups.entries()),
      ]);
    const groupsObj = Object.fromEntries(persistentGroups);
    this.context.workspaceState.update(
      this._getWorkspaceKey(this._groupsStorageKey),
      groupsObj,
    );

    // Save active stream
    this.context.workspaceState.update(
      this._activeStreamKey,
      this._activeStream,
    );

    // Save taskStates
    const taskStatesObj = Object.fromEntries(this._taskStates.entries());
    this.context.workspaceState.update(this._taskStateKey, taskStatesObj);
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    // Clean up old view if it exists
    this._cleanupView();

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

    // Initialize webview with current state
    this._updateWebview();

    // Handle webview messages
    this._viewDisposables.push(
      webviewView.webview.onDidReceiveMessage(async (message) => {
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

    const streams = Array.from(this._logStreams.keys());

    // Use stored active stream, fallback to first stream if active stream doesn't exist
    if (!streams.includes(this._activeStream)) {
      this._activeStream = streams[0] ?? '';
    }

    this._view.webview.postMessage({
      command: COMMANDS.UPDATE_STREAMS,
      streams,
      currentStream: this._activeStream,
    });
    this.updateLogContent(this._activeStream);

    // Update status for current stream
    if (this._activeStream) {
      const status = this._streamStatus.get(this._activeStream);
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
  }

  public addLogMessage(
    stream: string,
    message: string,
    level: 'error' | 'warn' | 'info' | 'debug' = 'info',
    groupId?: string,
  ) {
    // Skip if this stream should be excluded from the progress view
    if (shouldExcludeFromProgressView(stream)) {
      return;
    }

    // Skip debug messages if verbose output is disabled
    if (
      level === 'debug' &&
      !getConfig<boolean>('logger.verboseOutput', false)
    ) {
      return;
    }

    // Create stream if it doesn't exist
    if (!this._logStreams.has(stream)) {
      this.logger.debug(`Adding new stream to ProgressView: ${stream}`);
      this._logStreams.set(stream, []);

      // Set initial status to running for new streams
      if (!this._streamStatus.has(stream)) {
        this.updateStreamStatus(stream, STATUS.RUNNING);
      }

      // Auto-focus new agent streams - make this stream the active one
      this.setActiveStream(stream);

      // If the view exists, make sure the UI shows this as the active stream
      if (this._view) {
        this._view.show(true); // Show the panel and give it focus
        this.logger.debug(`Auto-focused to new stream: ${stream}`);
      }
    }

    const logMessage: ColoredLogMessage = {
      message,
      level,
      groupId,
    };

    const messages = this._logStreams.get(stream)!;
    messages.push(logMessage);

    if (messages.length > 1000) {
      messages.splice(0, messages.length - 1000);
    }

    this._saveState();

    if (this._view) {
      this._view.webview.postMessage({
        command: 'appendLog',
        stream: stream,
        logMessage,
      });
    }
  }

  public addLogGroup(
    stream: string,
    groupId: string,
    groupName: string,
    startTime: string,
    status: StatusType,
    endTime?: string,
    parentGroupId?: string,
  ) {
    // Skip if this stream should be excluded from the progress view
    if (shouldExcludeFromProgressView(stream)) {
      return;
    }

    // Create stream groups mapping if it doesn't exist
    if (!this._logGroups.has(stream)) {
      this._logGroups.set(stream, new Map());
    }

    const streamGroups = this._logGroups.get(stream)!;
    streamGroups.set(groupId, {
      id: groupId,
      name: groupName,
      startTime,
      endTime,
      status,
      parentGroupId,
    });

    this._saveState();

    if (this._view && stream === this._activeStream) {
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
    endTime?: string,
  ) {
    // Skip if this stream should be excluded from the progress view
    if (shouldExcludeFromProgressView(stream)) {
      return;
    }

    const streamGroups = this._logGroups.get(stream);
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

    this._saveState();

    if (this._view && stream === this._activeStream) {
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
    if (!stream || !this._logStreams.has(stream)) {
      const streams = Array.from(this._logStreams.keys());
      stream = streams[0] ?? '';
    }

    if (!this._logStreams.has(stream)) {
      return;
    }

    const messages = this._logStreams.get(stream)!;
    // Filter debug messages if verbose output is disabled
    const displayMessages = getConfig<boolean>('logger.verboseOutput', false)
      ? messages
      : messages.filter((msg) => msg.level !== 'debug');

    // Get groups for this stream
    const groups = this._logGroups.get(stream) || new Map();

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
  }

  public getLogStreams(): Map<string, ColoredLogMessage[]> {
    return this._logStreams;
  }

  public getLogGroups(): Map<string, Map<string, LogGroup>> {
    return this._logGroups;
  }

  public eraseStream(stream: string) {
    if (this._logStreams.has(stream)) {
      this._logStreams.get(stream)!.length = 0;
      this._logGroups.delete(stream);
      this._saveState();
      this.updateLogContent(stream);
    }
  }

  public deleteAllStreams() {
    this._logStreams.clear();
    this._logGroups.clear();
    this._taskStates.clear();
    this._saveState();
    if (this._view) {
      this._view.webview.postMessage({ command: COMMANDS.CLEAR_LOGS });
      this._updateWebview();
    }
  }

  public deleteStream(stream: string) {
    if (this._logStreams.has(stream)) {
      const streams = Array.from(this._logStreams.keys());

      // Case: This is the last stream - erase it first
      if (streams.length === 1) {
        this.eraseStream(stream);
      }

      // Remove the stream from collections
      this._logStreams.delete(stream);
      this._logGroups.delete(stream);
      this._taskStates.delete(stream);

      // If the deleted stream was the active one, switch to another stream if available
      if (stream === this._activeStream) {
        const remainingStreams = Array.from(this._logStreams.keys());
        this._activeStream = remainingStreams[0] ?? '';
      }

      this._saveState();
      this._updateWebview();
    }
  }

  public updateStreamStatus(stream: string, status: StreamStatusType) {
    // Don't track status for excluded streams
    if (shouldExcludeFromProgressView(stream)) {
      return;
    }

    if (!this._logStreams.has(stream)) {
      return;
    }

    this._streamStatus.set(stream, status);
    if (this._view && stream === this._activeStream) {
      this._view.webview.postMessage({
        command: COMMANDS.UPDATE_STATUS,
        status: status,
      });
    }
  }

  public getStreamStatus(stream: string): StreamStatusType | undefined {
    return this._streamStatus.get(stream);
  }

  public setActiveStream(stream: string) {
    if (this._logStreams.has(stream)) {
      this._activeStream = stream;
      this._saveState();
      this._updateWebview();
    }
  }

  public setTaskState(streamId: string, taskState: TaskState): void {
    this.logger.debug(`Setting taskState for stream: ${streamId}`);
    this.logger.debug(`Task state: ${JSON.stringify(taskState)}`);
    this._taskStates.set(streamId, taskState);
    this.saveTaskStates();
    this.logger.debug(
      `Current taskStates: ${JSON.stringify(Array.from(this._taskStates.entries()))}`,
    );
  }

  public getTaskState(streamId: string): TaskState | undefined {
    this.logger.debug(`Getting taskState for stream: ${streamId}`);
    const taskState = this._taskStates.get(streamId);
    if (!taskState) {
      this.logger.warn(`No taskState found for stream: ${streamId}`);
    } else {
      this.logger.debug(`Found taskState: ${JSON.stringify(taskState)}`);
    }
    return taskState;
  }

  private saveTaskStates(): void {
    this.logger.debug('Saving taskStates to workspace state');
    const taskStatesArray = Array.from(this._taskStates.entries());
    this.logger.debug(`Saving taskStates: ${JSON.stringify(taskStatesArray)}`);
    this.context.workspaceState.update(this._taskStateKey, taskStatesArray);
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
    const endTime = new Date().toISOString();
    const STATUS_CANCELLED = STATUS.ERROR;

    // Update each running stream
    for (const streamId of runningStreams) {
      // Mark stream as cancelled
      this._streamStatus.set(streamId, STATUS_CANCELLED);
      this.addLogMessage(
        streamId,
        'Task cancelled due to extension deactivation.',
        'warn',
      );

      // Update all active groups for this stream
      const streamGroups = this._logGroups.get(streamId);
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
    this._saveState();
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
    const endTime = new Date().toISOString();
    let updatedStreams = 0;
    let updatedGroups = 0;

    // Check all streams for inconsistencies
    for (const streamId of this._logStreams.keys()) {
      let wasUpdated = false;

      // Check if stream is running and mark as interrupted
      if (this._streamStatus.get(streamId) === STATUS.RUNNING) {
        this._streamStatus.set(streamId, STATUS_INTERRUPTED);
        this.addLogMessage(
          streamId,
          'Task was interrupted due to extension restart.',
          'warn',
        );
        wasUpdated = true;
        updatedStreams++;
      }

      // Check for running groups that need to be marked as interrupted
      const streamGroups = this._logGroups.get(streamId);
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
    this._saveState();
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
