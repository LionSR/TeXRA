// Third-party imports
import * as vscode from 'vscode';

// Local imports - webview
import { LogViewContentProvider } from './LogViewContentProvider';
import { LogViewMessageHandler } from './LogViewMessageHandler';
import { TaskState, fromObject } from './TaskState';
import { AgentLogger } from './AgentLogger';
import { getConfig } from '../frontend-utils/commonUtils';

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
  status: 'running' | 'error' | 'stopped' | 'ready';
  parentGroupId?: string;
}

// Channels that should only be written to VSCode output channel
const OUTPUT_CHANNEL_ONLY = new Set([
  'Webview',
  'TestCommands',
  'fileSelectionCommands',
  'packCommands',
  'cleanCommands',
  'MessageHandler',
  'AgentLoad',
  'Housekeeping',
  'LaTeXCommands',
  'Utils',
  'LogViewProvider',
  'executeAgent',
  'ImgUtils',
  'stateRestoreCommand',
]);

// Channels that should not be persisted in workspace storage
const NON_PERSISTENT_CHANNELS = new Set([...OUTPUT_CHANNEL_ONLY, 'ImgUtils']);

export class LogViewProvider implements vscode.WebviewViewProvider {
  private static _instance: LogViewProvider | undefined;
  private _view?: vscode.WebviewView;
  private _logStreams: Map<string, ColoredLogMessage[]> = new Map();
  private _logGroups: Map<string, Map<string, LogGroup>> = new Map(); // streamId -> groupId -> LogGroup
  private readonly _contentProvider: LogViewContentProvider;
  private readonly _messageHandler: LogViewMessageHandler;
  private readonly _storageKey = 'coauthor.logStreams';
  private readonly _groupsStorageKey = 'coauthor.logGroups';
  private readonly _taskStateKey = 'coauthor.taskStates';
  private _disposables: vscode.Disposable[] = [];
  private readonly _extensionUri: vscode.Uri;
  private readonly _viewTitle: string;
  private _viewDisposables: vscode.Disposable[] = [];
  private _streamStatus: Map<string, 'running' | 'error' | 'stopped'> =
    new Map();
  private _activeStream: string = '';
  private readonly _activeStreamKey = 'coauthor.activeLogStream';
  private _taskStates: Map<string, TaskState> = new Map();
  private readonly logger: AgentLogger;

  constructor(
    private readonly context: vscode.ExtensionContext,
    title: string = 'Tasks',
  ) {
    this._extensionUri = context.extensionUri;
    this._viewTitle = title;
    this._contentProvider = new LogViewContentProvider(context);
    this._messageHandler = new LogViewMessageHandler(this);
    this._loadState();
    this.logger = new AgentLogger('LogViewProvider');

    // Set instance
    LogViewProvider._instance = this;

    // Listen for workspace folder changes
    this._disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this._loadState();
        this._updateWebview();
      }),
    );
  }

  public static getInstance(): LogViewProvider | undefined {
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

  private _getWorkspaceKey(): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder
      ? `${this._storageKey}.${workspaceFolder.uri.fsPath}`
      : this._storageKey;
  }

  private _getGroupsWorkspaceKey(): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder
      ? `${this._groupsStorageKey}.${workspaceFolder.uri.fsPath}`
      : this._groupsStorageKey;
  }

  private _loadState() {
    const savedState = this.context.workspaceState.get<{
      [key: string]: ColoredLogMessage[];
    }>(this._getWorkspaceKey());
    if (savedState) {
      // Only load channels that are not in the blacklist
      this._logStreams = new Map(
        Object.entries(savedState).filter(
          ([channel]) => !NON_PERSISTENT_CHANNELS.has(channel),
        ),
      );
    } else {
      this._logStreams.clear();
    }

    // Load groups
    const savedGroups = this.context.workspaceState.get<{
      [key: string]: { [groupId: string]: LogGroup };
    }>(this._getGroupsWorkspaceKey());
    if (savedGroups) {
      this._logGroups = new Map(
        Object.entries(savedGroups)
          .filter(([channel]) => !NON_PERSISTENT_CHANNELS.has(channel))
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
      this._activeStream = Array.from(this._logStreams.keys())[0] || '';
    }

    // Load taskStates
    const savedTaskStates = this.context.workspaceState.get<{
      [key: string]: Record<string, any>;
    }>(this._taskStateKey);
    if (savedTaskStates) {
      this._taskStates = new Map(
        Object.entries(savedTaskStates).map(([stream, state]) => [
          stream,
          fromObject(state),
        ]),
      );
    } else {
      this._taskStates.clear();
    }
  }

  private _saveState() {
    // Only save channels that are not in the blacklist
    const persistentStreams = Array.from(this._logStreams.entries()).filter(
      ([channel]) => !NON_PERSISTENT_CHANNELS.has(channel),
    );
    const stateObj = Object.fromEntries(persistentStreams);
    this.context.workspaceState.update(this._getWorkspaceKey(), stateObj);

    // Save groups
    const persistentGroups = Array.from(this._logGroups.entries())
      .filter(([channel]) => !NON_PERSISTENT_CHANNELS.has(channel))
      .map(([streamId, groups]) => [
        streamId,
        Object.fromEntries(groups.entries()),
      ]);
    const groupsObj = Object.fromEntries(persistentGroups);
    this.context.workspaceState.update(
      this._getGroupsWorkspaceKey(),
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

    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'src', 'logger', 'logView'),
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
    if (!this._view) return;

    const streams = Array.from(this._logStreams.keys());

    // Use stored active stream, fallback to first stream if active stream doesn't exist
    if (!streams.includes(this._activeStream)) {
      this._activeStream = streams[0] || '';
    }

    this._view.webview.postMessage({
      command: 'updateStreams',
      streams,
      currentStream: this._activeStream,
    });
    this.updateLogContent(this._activeStream);

    // Update status for current stream
    if (this._activeStream) {
      const status = this._streamStatus.get(this._activeStream);
      if (status) {
        this._view.webview.postMessage({
          command: 'updateStatus',
          status: status,
        });
      }
    } else {
      // If no active stream, show ready state
      this._view.webview.postMessage({
        command: 'updateStatus',
        status: 'ready',
      });
    }
  }

  public addLogMessage(
    stream: string,
    message: string,
    level: 'error' | 'warn' | 'info' | 'debug' = 'info',
    groupId?: string,
  ) {
    // Skip if this stream should only be written to output channel
    if (OUTPUT_CHANNEL_ONLY.has(stream)) {
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
      this._logStreams.set(stream, []);
      // Set initial status to running for new streams
      if (!this._streamStatus.has(stream)) {
        this.updateStreamStatus(stream, 'running');
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
    status: 'running' | 'error' | 'stopped' | 'ready',
    endTime?: string,
    parentGroupId?: string,
  ) {
    // Skip if this stream should only be written to output channel
    if (OUTPUT_CHANNEL_ONLY.has(stream)) {
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
        command: 'addLogGroup',
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
    status: 'running' | 'error' | 'stopped' | 'ready',
    endTime?: string,
  ) {
    // Skip if this stream should only be written to output channel
    if (OUTPUT_CHANNEL_ONLY.has(stream)) {
      return;
    }

    const streamGroups = this._logGroups.get(stream);
    if (!streamGroups) return;

    const group = streamGroups.get(groupId);
    if (!group) return;

    group.status = status;
    if (endTime) {
      group.endTime = endTime;
    }

    this._saveState();

    if (this._view && stream === this._activeStream) {
      this._view.webview.postMessage({
        command: 'updateLogGroup',
        stream,
        groupId,
        status,
        endTime,
      });
    }
  }

  public updateLogContent(stream: string) {
    if (!this._view) return;

    // If no stream is provided or stream doesn't exist, use the first available stream
    if (!stream || !this._logStreams.has(stream)) {
      const streams = Array.from(this._logStreams.keys());
      stream = streams[0] || '';
    }

    if (!this._logStreams.has(stream)) return;

    const messages = this._logStreams.get(stream)!;
    // Filter debug messages if verbose output is disabled
    const displayMessages = getConfig<boolean>('logger.verboseOutput', false)
      ? messages
      : messages.filter((msg) => msg.level !== 'debug');

    // Get groups for this stream
    const groups = this._logGroups.get(stream) || new Map();

    this._view.webview.postMessage({
      command: 'updateLogs',
      stream: stream,
      messages: displayMessages,
      groups: Array.from(groups.values()),
    });

    // Send current status for the stream
    const status = this._streamStatus.get(stream) || 'stopped';
    this._view.webview.postMessage({
      command: 'updateStatus',
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
      this._view.webview.postMessage({ command: 'clearLogs' });
      this._updateWebview();
    }
  }

  public deleteStream(stream: string) {
    if (this._logStreams.has(stream)) {
      this._logStreams.delete(stream);
      this._logGroups.delete(stream);
      this._taskStates.delete(stream);
      this._saveState();
      this._updateWebview();
    }
  }

  public updateStreamStatus(
    stream: string,
    status: 'running' | 'error' | 'stopped',
  ) {
    if (!this._logStreams.has(stream)) {
      return;
    }

    this._streamStatus.set(stream, status);
    if (this._view && stream === this._activeStream) {
      this._view.webview.postMessage({
        command: 'updateStatus',
        status: status,
      });
    }
  }

  public getStreamStatus(
    stream: string,
  ): 'running' | 'error' | 'stopped' | undefined {
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
}
