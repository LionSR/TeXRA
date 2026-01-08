// Third-party imports
import * as vscode from 'vscode';

// Internal imports
import type { OutputFileInfo } from '@agent/output/types';
import type { IRunStorageService } from '@agent/runtime/RunStorageService';
import { setRunStorageService } from '@agent/runtime/RunStorageService';
import type { StreamTabId, StorageKey } from '@agent/types/IdentifierTypes';
import { BaseWebviewProvider } from '@common/webview';
import { getSharedLocalResourceRoots } from '@common/webview';
import { AgentLogger } from '@logger/AgentLogger';

// Local file imports
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import type { ToolEditApprovalPrompt } from '@eventBus/types';
import { ProgressEventHandler } from './events/ProgressEventHandler';
import { WebviewUpdater } from './managers';
// @ts-ignore - Import JavaScript module
import { ProgressViewContentProvider } from './ProgressViewContentProvider';
import { ProgressViewMessageHandler } from './ProgressViewMessageHandler';
import { ProgressViewState } from './state/ProgressViewState';

// Types

// Type imports

/**
 * Refactored ProgressViewProvider using the new modular architecture.
 * This class now focuses on orchestration and delegation to focused managers,
 * following the design principles from AGENTS.md.
 *
 * Supports two simultaneous views:
 * - Sidebar view (_view): Standard VS Code webview view in the bottom panel
 * - Panel view (_panelView): Standalone editor tab for more screen real estate
 * Both views share state and receive synchronized updates via WebviewUpdater.
 *
 * Implements IRunStorageService to provide run state access to the agent runtime
 * without creating circular dependencies.
 */
export class ProgressViewProvider
  extends BaseWebviewProvider
  implements vscode.WebviewViewProvider, IRunStorageService
{
  public static readonly viewType = 'texra.progressView';
  private static _instance: ProgressViewProvider | undefined;

  // New modular architecture components
  public readonly state: ProgressViewState;
  public readonly eventHandler: ProgressEventHandler;
  public readonly webviewUpdater: WebviewUpdater;

  // Existing components (will be gradually updated)
  protected readonly contentProvider: ProgressViewContentProvider;
  protected readonly messageHandler: ProgressViewMessageHandler;

  // Infrastructure
  private readonly _viewTitle: string;
  private _webviewReady = false;
  // Separate panel view (editor tab) from sidebar view
  private _panelView?: vscode.WebviewPanel;
  private _panelDisposables: vscode.Disposable[] = [];
  /**
   * Tracks pending update options when webview is not ready.
   * Uses an object instead of boolean to preserve forceRebuild requests.
   * null = no pending update, object = pending with accumulated options.
   */
  private _pendingUpdateOptions: { forceRebuild: boolean } | null = null;
  private _hasResolved = false;
  private readonly logger: AgentLogger;
  private readonly pendingApprovalPrompts = new Map<
    string,
    ToolEditApprovalPrompt
  >();
  private readonly pendingRetryRequests = new Map<
    string,
    ProgressEventPayloads['showRetryRequest']
  >();
  private approvalBypassActive = false;

  constructor(
    protected readonly context: vscode.ExtensionContext,
    title: string = 'Tasks',
  ) {
    super(context);
    this._viewTitle = title;
    this.logger = new AgentLogger('ProgressViewProvider');

    // Initialize new modular architecture
    this.state = new ProgressViewState();
    // WebviewUpdater sends to all available webviews (sidebar + panel)
    this.webviewUpdater = new WebviewUpdater(() => [
      this._view?.webview,
      this._panelView?.webview,
    ]);
    this.eventHandler = new ProgressEventHandler(
      this.state,
      this.webviewUpdater,
      {
        showRetryRequest: this.showRetryRequest.bind(this),
        resolveRetryRequest: this.resolveRetryRequest.bind(this),
        showToolEditApprovalPrompt: this.showToolEditApprovalPrompt.bind(this),
        resolveToolEditApprovalPrompt:
          this.resolveToolEditApprovalPrompt.bind(this),
        updateToolEditApprovalBypassState:
          this.updateToolEditApprovalBypassState.bind(this),
      },
    );

    // Initialize existing components
    this.contentProvider = new ProgressViewContentProvider(context);
    this.messageHandler = new ProgressViewMessageHandler(this, context);

    // Set instance and register as run storage service
    ProgressViewProvider._instance = this;
    setRunStorageService(this);

    // Listen for workspace folder changes
    this._disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        await this.state.load();
        // Force rebuild after state reload to ensure freshly loaded data is rendered
        this.updateWebview({ forceRebuild: true });
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

    this.logger.debug(
      'ProgressViewProvider initialized with new modular architecture',
    );
  }

  public static getInstance(): ProgressViewProvider | undefined {
    return this._instance;
  }

  protected override cleanupView(): void {
    super.cleanupView();
    this._webviewReady = false;
    this._pendingUpdateOptions = null;
    this.state.clearRenderedStreamTracking();
  }

  /**
   * Common setup for any webview (sidebar or panel).
   * Sets HTML content, message handler, and theme listener.
   * @returns disposables that should be cleaned up when the view is disposed
   */
  private setupWebviewContent(
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];

    // Set HTML content
    view.webview.html = this.contentProvider.getHtmlContent(view.webview);

    // Setup message handling
    disposables.push(
      view.webview.onDidReceiveMessage((message) =>
        this.messageHandler.handleMessage(message, view),
      ),
    );

    // Setup theme change listener
    disposables.push(
      vscode.window.onDidChangeActiveColorTheme(() => {
        if (view.visible) {
          this.updateWebview();
        }
      }),
    );

    return disposables;
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    // Mark running tasks as cancelled on subsequent webview resolves
    if (this._hasResolved) {
      this.resetRunningStreamStatuses();
    }
    this._hasResolved = true;

    this._webviewReady = false;
    this._pendingUpdateOptions = null;
    // Clear rendered stream tracking to force rebuild - DOM state is stale after resolve
    this.state.clearRenderedStreamTracking();

    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
      localResourceRoots: getSharedLocalResourceRoots(
        this.context,
        'progressView',
      ),
    };
    webviewView.title = this._viewTitle;

    // Clean up old view and set new one
    this.cleanupView();
    this._view = webviewView;

    // Setup content, message handler, and theme listener
    const disposables = this.setupWebviewContent(webviewView);
    this._viewDisposables.push(...disposables);

    // Add visibility listener (specific to sidebar)
    this._viewDisposables.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.updateWebview();
        }
      }),
      webviewView.onDidDispose(this.cleanupView.bind(this)),
    );

    this.updateWebview();
  }

  /**
   * Update webview content using the new architecture.
   * WebviewUpdater automatically sends to all registered webviews (sidebar + panel).
   * @param options.forceRebuild - Force full DOM rebuild in frontend
   */
  public updateWebview(options?: { forceRebuild?: boolean }): void {
    if (!this._view && !this._panelView) return;

    if (!this._webviewReady) {
      // Queue the update, preserving forceRebuild if any caller requested it.
      // Once forceRebuild is true, it stays true until the update is processed.
      const currentForce = this._pendingUpdateOptions?.forceRebuild ?? false;
      const requestedForce = options?.forceRebuild ?? false;
      this._pendingUpdateOptions = {
        forceRebuild: currentForce || requestedForce,
      };
      return;
    }

    const theme =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
        ? 'dark'
        : 'light';

    const activeStream = this.webviewUpdater.updateAll(
      this.state,
      this.eventHandler.getAllStreamStatuses(),
      theme,
    );

    // Use state as single source of truth for stream switch detection
    const isStreamSwitch = this.state.isStreamSwitch(activeStream);
    const shouldForceRebuild = options?.forceRebuild ?? isStreamSwitch;

    this.eventHandler.refreshStreamSurface(activeStream || '', {
      forceRebuild: shouldForceRebuild,
    });

    // Mark stream as rendered for future switch detection
    this.state.markStreamRendered(activeStream);
    this._pendingUpdateOptions = null;
  }

  /**
   * Mark the webview as ready and process any pending updates.
   */
  public markWebviewReady(): void {
    this._webviewReady = true;

    // Clear pending options - we always force rebuild on first load anyway,
    // and that takes precedence over any pending options.
    this._pendingUpdateOptions = null;
    this.updateWebview({ forceRebuild: true });

    if (this.webviewUpdater.isAvailable()) {
      // Replay pending approval prompts
      for (const prompt of this.pendingApprovalPrompts.values()) {
        this.webviewUpdater.showToolEditApprovalPrompt(prompt);
      }
      this.webviewUpdater.updateToolEditApprovalState(
        this.approvalBypassActive,
      );

      // Replay pending retry requests
      for (const payload of this.pendingRetryRequests.values()) {
        this.webviewUpdater.showRetryRequest(payload);
      }
    }
  }

  public showToolEditApprovalPrompt(prompt: ToolEditApprovalPrompt): void {
    this.pendingApprovalPrompts.set(prompt.requestId, prompt);

    if (this._webviewReady && this.webviewUpdater.isAvailable()) {
      this.webviewUpdater.showToolEditApprovalPrompt(prompt);
    }
  }

  public resolveToolEditApprovalPrompt(requestId: string): void {
    this.pendingApprovalPrompts.delete(requestId);

    if (this._webviewReady && this.webviewUpdater.isAvailable()) {
      this.webviewUpdater.resolveToolEditApprovalPrompt(requestId);
    }
  }

  public updateToolEditApprovalBypassState(bypassActive: boolean): void {
    this.approvalBypassActive = bypassActive;

    if (this._webviewReady && this.webviewUpdater.isAvailable()) {
      this.webviewUpdater.updateToolEditApprovalState(bypassActive);
    }
  }

  public showRetryRequest(
    payload: ProgressEventPayloads['showRetryRequest'],
  ): void {
    this.pendingRetryRequests.set(payload.streamId, payload);

    if (this._webviewReady && this.webviewUpdater.isAvailable()) {
      this.webviewUpdater.showRetryRequest(payload);
    }
  }

  public resolveRetryRequest(streamId: string): void {
    this.pendingRetryRequests.delete(streamId);

    if (this._webviewReady && this.webviewUpdater.isAvailable()) {
      this.webviewUpdater.resolveRetryRequest(streamId);
    }
  }

  /**
   * Cleanup tasks after restart (legacy compatibility)
   */
  public async cleanupTasksAfterRestart(
    waitingStreams?: Set<string>,
  ): Promise<void> {
    // Use the same logic as webview reload to mark all running tasks/groups as ERROR
    await this.resetRunningStreamStatuses(waitingStreams);
    // Force rebuild since we modified task states
    this.updateWebview({ forceRebuild: true });
  }

  /**
   * Check if any view is visible (sidebar or panel)
   */
  public isViewVisible(): boolean {
    return (this._view?.visible ?? false) || (this._panelView?.visible ?? false);
  }

  // ===== IRunStorageService implementation =====

  /**
   * Get the active run ID for a stream.
   * Implements IRunStorageService.getActiveRunId
   */
  public getActiveRunId(stream: StreamTabId): StorageKey | null {
    return this.state.getActiveRunId(stream);
  }

  /**
   * Get output files for a specific run within a stream.
   * Implements IRunStorageService.getRunOutputFiles
   */
  public getRunOutputFiles(
    stream: StreamTabId,
    options: { storageKey: StorageKey },
  ): Map<number, OutputFileInfo[]> | undefined {
    return this.state.getRunOutputFiles(stream, options);
  }

  // ===== End IRunStorageService implementation =====

  /**
   * Reset running stream statuses when webview reloads
   * Sets all running streams and their groups to ERROR status
   */
  private async resetRunningStreamStatuses(
    waitingStreams?: Set<string>,
  ): Promise<void> {
    // Get affected streams and set their status to ERROR
    const affectedStreams =
      this.eventHandler.resetRunningTasksToError(waitingStreams);

    const streamsWithRunningGroups =
      await this.state.taskGroups.endRunningGroups(Date.now());

    for (const streamId of streamsWithRunningGroups) {
      if (!affectedStreams.includes(streamId)) {
        this.logger.debug(
          `Stream ${streamId} had running groups but wasn't marked as affected`,
        );
      }
    }
  }

  /**
   * Set active stream (used by message handler)
   */
  public setActiveStream(stream: string): void {
    this.state.activeStream = stream;
    this.updateWebview();
  }

  /**
   * Open the progress view in a separate editor tab (WebviewPanel).
   * This creates a standalone panel that can be positioned anywhere in the editor.
   * The panel is tracked separately from the sidebar view.
   */
  public showProgressViewAsPanel(): void {
    // If panel already exists, reveal it
    if (this._panelView) {
      this._panelView.reveal(vscode.ViewColumn.One);
      this.updateWebview({ forceRebuild: true });
      return;
    }

    // Create new panel
    this._panelView = vscode.window.createWebviewPanel(
      ProgressViewProvider.viewType + '.panel',
      'TeXRA ProgressBoard',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        enableCommandUris: true,
        retainContextWhenHidden: true,
        localResourceRoots: getSharedLocalResourceRoots(
          this.context,
          'progressView',
        ),
      },
    );

    // Setup content, message handler, and theme listener (shared with sidebar)
    this._panelDisposables.push(...this.setupWebviewContent(this._panelView));

    // Add visibility listener (panel uses onDidChangeViewState instead of onDidChangeVisibility)
    this._panelDisposables.push(
      this._panelView.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) {
          this.updateWebview();
        }
      }),
    );

    // Cleanup on panel dispose (added to disposables for consistency)
    this._panelDisposables.push(
      this._panelView.onDidDispose(() => {
        this._panelDisposables.forEach((d) => d.dispose());
        this._panelDisposables = [];
        this._panelView = undefined;
      }),
    );

    // Trigger initial update (webview will send WEBVIEW_READY when loaded)
    this.updateWebview();
  }

  public override dispose(): void {
    // Clean up panel resources
    this._panelDisposables.forEach((d) => d.dispose());
    this._panelDisposables = [];
    this._panelView?.dispose();
    this._panelView = undefined;
    super.dispose();
  }
}
