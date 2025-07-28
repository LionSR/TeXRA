// Third-party imports
import * as vscode from 'vscode';

// Local imports - new architecture
import { StatePersistenceManager } from './persistence/StatePersistenceManager';
import { ProgressViewState } from './state/ProgressViewState';
import { ProgressEventHandler } from './events/ProgressEventHandler';
import { WebviewUpdater } from './managers';

// Local imports - existing components
import { ProgressViewContentProvider } from './ProgressViewContentProvider';
import { ProgressViewMessageHandler } from './ProgressViewMessageHandler';
import { AgentLogger } from '@logger/AgentLogger';

// Types
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';
import { TaskState } from '@logger/TaskState';
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import { LogMessageData } from '@logger/LogTypes';
import { watchConfig } from '@utils/config';

// @ts-ignore - Import JavaScript module
import { STATUS, COMMANDS } from './modules/constants.js';

// Type aliases for status values
type StreamStatusType =
  | typeof STATUS.RUNNING
  | typeof STATUS.ERROR
  | typeof STATUS.STOPPED;

/**
 * Refactored ProgressViewProvider using the new modular architecture.
 * This class now focuses on orchestration and delegation to focused managers,
 * following the design principles from AGENTS.md.
 */
export class ProgressViewProvider implements vscode.WebviewViewProvider {
  private static _instance: ProgressViewProvider | undefined;
  private _view?: vscode.WebviewView;

  // New modular architecture components
  public readonly state: ProgressViewState;
  public readonly eventHandler: ProgressEventHandler;
  public readonly webviewUpdater: WebviewUpdater;

  // Existing components (will be gradually updated)
  private readonly contentProvider: ProgressViewContentProvider;
  private readonly messageHandler: ProgressViewMessageHandler;

  // Infrastructure
  private _disposables: vscode.Disposable[] = [];
  private _viewDisposables: vscode.Disposable[] = [];
  private readonly _extensionUri: vscode.Uri;
  private readonly _viewTitle: string;
  private _webviewReady = false;
  private _pendingUpdate = false;
  private readonly logger: AgentLogger;

  constructor(
    private readonly context: vscode.ExtensionContext,
    title: string = 'Tasks',
  ) {
    this._extensionUri = context.extensionUri;
    this._viewTitle = title;
    this.logger = new AgentLogger('ProgressViewProviderNew');

    // Initialize new modular architecture
    const persistenceManager = new StatePersistenceManager(
      context.workspaceState,
    );
    this.state = new ProgressViewState(persistenceManager);
    this.webviewUpdater = new WebviewUpdater(() => this._view?.webview);
    this.eventHandler = new ProgressEventHandler(
      this.state,
      this.webviewUpdater,
    );

    // Initialize existing components
    this.contentProvider = new ProgressViewContentProvider(context);
    this.messageHandler = new ProgressViewMessageHandler(this);

    // Set instance
    ProgressViewProvider._instance = this;

    // Listen for workspace folder changes
    this._disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        await this.state.load();
        this.updateWebview();
      }),
    );
  }

  /**
   * Initialize provider state. Must be called after construction.
   */
  public async initialize(): Promise<void> {
    await this.state.load();

    watchConfig(this.context, 'texra.progressView.sortStreamsBy', () =>
      this.updateWebview(),
    );

    // Setup event listeners using the new architecture
    this._disposables.push(...this.eventHandler.setupEventListeners());

    this.logger.debug(
      'ProgressViewProvider initialized with new modular architecture',
    );
  }

  public static getInstance(): ProgressViewProvider | undefined {
    return this._instance;
  }

  public dispose(): void {
    this._disposables.forEach((d) => d.dispose());
    this.cleanupView();
  }

  private cleanupView(): void {
    this._viewDisposables.forEach((d) => d.dispose());
    this._viewDisposables = [];
    this._view = undefined;
    this._webviewReady = false;
    this._pendingUpdate = false;
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.cleanupView();

    // Mark all running tasks as cancelled since they will lose contact when webview reloads
    this.resetRunningStreamStatuses();

    this._webviewReady = false;
    this._pendingUpdate = false;
    this._view = webviewView;

    this.setupWebview(webviewView);
    this.updateWebview();
  }

  /**
   * Setup webview configuration and event handlers
   */
  private setupWebview(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'src', 'progressView'),
        vscode.Uri.joinPath(this._extensionUri, 'src', 'common', 'styles'),
        vscode.Uri.joinPath(this._extensionUri, 'src', 'common', 'modules'),
        vscode.Uri.joinPath(this._extensionUri, 'src', 'common', 'webview'),
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

    webviewView.title = this._viewTitle;

    // Set initial HTML content
    webviewView.webview.html = this.contentProvider.getHtmlContent(
      webviewView.webview,
    );

    // Setup event handlers
    this._viewDisposables.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.updateWebview();
        }
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        if (webviewView.visible) {
          this.updateWebview();
        }
      }),
      webviewView.webview.onDidReceiveMessage(async (message) => {
        if (message.command === COMMANDS.WEBVIEW_READY) {
          this._webviewReady = true;
          // Always update webview when it becomes ready to ensure all streams are shown
          this.updateWebview();
          return;
        }
        await this.messageHandler.handleMessage(message, webviewView);
      }),
      webviewView.onDidDispose(() => {
        this.cleanupView();
      }),
    );
  }

  /**
   * Update webview content using the new architecture
   */
  public updateWebview(): void {
    if (!this._view) return;

    if (!this._webviewReady) {
      this._pendingUpdate = true;
      return;
    }

    // Validate and update active stream if necessary
    const streams = this.state.streamTabs.keys();
    if (!streams.includes(this.state.activeStream)) {
      this.state.activeStream = streams[0] || '';
    }

    // Update all webview content using the new updater
    this.webviewUpdater.updateAll(this.state);

    // Update status for current stream
    if (this.state.activeStream) {
      const status = this.eventHandler.getStreamStatus(this.state.activeStream);
      if (status) {
        this.webviewUpdater.updateStatus(status);
      }
    } else {
      this.webviewUpdater.updateStatus(STATUS.READY);
    }

    this._pendingUpdate = false;
  }

  // Public API methods - these delegate to the new architecture

  /**
   * Clear task output (legacy compatibility)
   */
  public clearTaskOutput(streamTabId: StreamTabId): void {
    const taskState = this.state.getTaskState(streamTabId);
    if (taskState) {
      // Only clear output-related fields, preserve other task state data
      taskState.agentConfig.outputFiles = [];
      if (taskState.activeFiles) {
        taskState.activeFiles.output = false;
      }
      this.state.setTaskState(streamTabId, taskState);
    }
  }

  /**
   * Cleanup tasks after restart (legacy compatibility)
   */
  public cleanupTasksAfterRestart(): void {
    // Use the same logic as webview reload to mark all running tasks/groups as ERROR
    this.resetRunningStreamStatuses();
    this.updateWebview();
  }

  /**
   * Check if view is visible (legacy compatibility)
   */
  public isViewVisible(): boolean {
    return this._view?.visible ?? false;
  }

  /**
   * Reset running stream statuses when webview reloads
   * Sets all running streams and their groups to ERROR status
   */
  private resetRunningStreamStatuses(): void {
    // Get affected streams and set their status to ERROR
    const affectedStreams = this.eventHandler.resetRunningTasksToError();

    // Also check ALL streams for running groups, not just affected streams
    // This ensures we catch any groups that might be running even if stream status is not
    for (const [streamId, groups] of this.state.taskGroups.getAll().entries()) {
      if (groups.size > 0) {
        let groupsUpdated = false;
        for (const [groupId, group] of groups.entries()) {
          if (group.status === STATUS.RUNNING) {
            // Update the group to ERROR status with current end time
            const endTime = Date.now();
            this.state.taskGroups.updateGroup(streamId, groupId, {
              status: STATUS.ERROR,
              endTime,
            });

            this.logger.debug(
              `Group ${groupId} in stream ${streamId} set to ERROR due to webview reload`,
            );
            groupsUpdated = true;
          }
        }

        // If we updated groups but the stream wasn't in affected streams,
        // we should still ensure the webview updates
        if (groupsUpdated && !affectedStreams.includes(streamId)) {
          this.logger.debug(
            `Stream ${streamId} had running groups but wasn't marked as affected`,
          );
        }
      }
    }

    // The TaskGroupManager.updateGroup() method automatically saves state
  }

  /**
   * Update log content for a stream (used by message handler)
   * Now properly focused on just updating log content with groups
   */
  public updateLogContent(stream: string): void {
    if (!this.webviewUpdater.isAvailable()) return;

    // If no stream is provided or stream doesn't exist, use the first available stream
    if (!stream || !this.state.streamTabs.has(stream)) {
      const streams = this.state.streamTabs.keys();
      stream = streams[0] ?? '';
    }

    if (!this.state.streamTabs.has(stream)) {
      return;
    }

    // Update only log content and groups (focused responsibility)
    const messages = this.state.streamTabs.get(stream) || [];
    const groups = Array.from(
      this.state.taskGroups.getStreamGroups(stream).values(),
    );
    this.webviewUpdater.updateLogContent(stream, messages, groups);
  }

  /**
   * Set active stream (used by message handler)
   */
  public setActiveStream(stream: string): void {
    this.state.activeStream = stream;
    this.updateWebview();
  }
}
