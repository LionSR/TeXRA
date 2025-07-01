// Third-party imports
import * as vscode from 'vscode';

// Local imports - new architecture
import { StatePersistenceManager } from './persistence/StatePersistenceManager';
import { ProgressViewState } from './state/ProgressViewState';
import { ProgressEventHandler } from './events/ProgressEventHandler';
import { WebviewUpdater } from './webview/WebviewUpdater';

// Local imports - existing components
import { ProgressViewContentProvider } from './ProgressViewContentProvider';
import { ProgressViewMessageHandler } from './ProgressViewMessageHandler';
import { IProgressViewProvider } from './interfaces/IProgressViewProvider';
import { AgentLogger } from '@logger/AgentLogger';

// Types
import type { StreamTabId, ExecutionId } from '../types/IdentifierTypes';
import { TaskState } from '@logger/TaskState';
import { TokenUsageStats } from '../types/UsageTypes';
import { LogMessageData } from '../logger/LogTypes';

// @ts-ignore - Import JavaScript module
import { STATUS, COMMANDS } from './modules/constants.js';

// Type aliases for status values
type StreamStatusType = typeof STATUS.RUNNING | typeof STATUS.ERROR | typeof STATUS.STOPPED;

/**
 * Refactored ProgressViewProvider using the new modular architecture.
 * This class now focuses on orchestration and delegation to focused managers,
 * following the design principles from AGENTS.md.
 */
export class ProgressViewProvider implements vscode.WebviewViewProvider, IProgressViewProvider {
  private static _instance: ProgressViewProvider | undefined;
  private _view?: vscode.WebviewView;
  
  // New modular architecture components
  private readonly state: ProgressViewState;
  private readonly eventHandler: ProgressEventHandler;
  private readonly webviewUpdater: WebviewUpdater;
  
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
    const persistenceManager = new StatePersistenceManager(context.workspaceState);
    this.state = new ProgressViewState(persistenceManager);
    this.webviewUpdater = new WebviewUpdater(() => this._view?.webview);
    this.eventHandler = new ProgressEventHandler(this.state, this.webviewUpdater);

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
    
    // Setup event listeners using the new architecture
    this._disposables.push(...this.eventHandler.setupEventListeners());
    
    this.logger.debug('ProgressViewProvider initialized with new modular architecture');
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
    webviewView.webview.html = this.contentProvider.getHtmlContent(webviewView.webview);

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
          if (this._pendingUpdate) {
            this.updateWebview();
          }
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
  private updateWebview(): void {
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
      const status = this.eventHandler.getStreamStatus(this.state.activeStream) || STATUS.READY;
      this.webviewUpdater.updateStatus(status);
    } else {
      this.webviewUpdater.updateStatus(STATUS.READY);
    }

    this._pendingUpdate = false;
  }

  // Public API methods - these delegate to the new architecture
  
  /**
   * Get stream tabs (legacy compatibility)
   */
  public getStreamTabs(): Map<string, LogMessageData[]> {
    return this.state.streamTabs.getAll();
  }

  /**
   * Get task groups (legacy compatibility)
   */
  public getTaskGroups(): Map<string, Map<string, any>> {
    return this.state.taskGroups.getAll();
  }

  /**
   * Erase a stream (legacy compatibility)
   */
  public eraseStream(stream: string): void {
    this.state.clearStream(stream);
    this.updateWebview();
  }

  /**
   * Delete all streams (legacy compatibility)
   */
  public deleteAllStreams(): void {
    this.state.clearAll();
    this.updateWebview();
  }

  /**
   * Delete a specific stream (legacy compatibility)
   */
  public deleteStream(stream: string): void {
    this.state.clearStream(stream);
    this.updateWebview();
  }

  /**
   * Get stream status (legacy compatibility)
   */
  public getStreamStatus(stream: string): StreamStatusType | undefined {
    return this.eventHandler.getStreamStatus(stream);
  }

  /**
   * Get output files for a stream (legacy compatibility)
   */
  public getOutputFiles(stream: string): { [key: number]: any[] } | undefined {
    return this.state.outputFiles.getFiles(stream);
  }

  /**
   * Get missing outputs for a stream (legacy compatibility)
   */
  public getMissingOutputs(stream: string): { [key: number]: string[] } | undefined {
    return this.state.outputFiles.getMissingOutputs(stream);
  }

  /**
   * Get stream usage (legacy compatibility)
   */
  public getStreamUsage(stream: string): TokenUsageStats | undefined {
    return this.state.usageStats.getStreamUsage(stream);
  }

  /**
   * Set task state (legacy compatibility)
   */
  public setTaskState(
    streamTabId: StreamTabId,
    taskState: TaskState,
    options?: { executionId?: ExecutionId }
  ): void {
    this.state.setTaskState(streamTabId, taskState);
    if (options?.executionId) {
      this.state.setExecutionId(streamTabId, options.executionId);
    }
  }

  /**
   * Get execution ID (legacy compatibility)
   */
  public getExecutionId(streamTabId: StreamTabId): ExecutionId | undefined {
    return this.state.getExecutionId(streamTabId);
  }

  /**
   * Get task state (legacy compatibility)
   */
  public getTaskState(streamTabId: StreamTabId): TaskState | undefined {
    return this.state.getTaskState(streamTabId);
  }

  /**
   * Clear task output (legacy compatibility)
   */
  public clearTaskOutput(streamTabId: StreamTabId): void {
    this.state.clearTaskState(streamTabId);
    this.state.clearExecutionId(streamTabId);
  }

  /**
   * Mark all running tasks as cancelled (legacy compatibility)
   */
  public markAllRunningTasksAsCancelled(): void {
    this.eventHandler.markAllRunningTasksAsCancelled();
  }

  /**
   * Cleanup tasks after restart (legacy compatibility)
   */
  public cleanupTasksAfterRestart(): void {
    this.eventHandler.markAllRunningTasksAsCancelled();
    this.updateWebview();
  }

  /**
   * Check if view is visible (legacy compatibility)
   */
  public isViewVisible(): boolean {
    return this._view?.visible ?? false;
  }

  /**
   * Update log content for a stream (used by message handler)
   */
  public updateLogContent(stream: string): void {
    if (!this.webviewUpdater.isAvailable()) return;
    
    const messages = this.state.streamTabs.get(stream) || [];
    this.webviewUpdater.updateLogContent(stream, messages);
  }

  /**
   * Set active stream (used by message handler)
   */
  public setActiveStream(stream: string): void {
    this.state.activeStream = stream;
    this.updateWebview();
  }
}