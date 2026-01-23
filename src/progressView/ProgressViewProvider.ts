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
import { isApprovalBypassedForStream } from '@tools/approval/toolEditApproval';
import { isBashApprovalBypassedForStream } from '@tools/approval/bashApproval';

// Local file imports
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import type {
  ToolEditApprovalPrompt,
  BashApprovalPrompt,
  AgentProposalPrompt,
} from '@eventBus/types';
import { ProgressEventHandler } from './events/ProgressEventHandler';
import { WebviewUpdater } from './managers';
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
  private _sidebarReady = false;
  private _panelReady = false;
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
  private readonly pendingBashApprovalPrompts = new Map<
    string,
    BashApprovalPrompt
  >();
  private readonly pendingRetryRequests = new Map<
    string,
    ProgressEventPayloads['showRetryRequest']
  >();
  private readonly pendingAgentProposals = new Map<
    string,
    AgentProposalPrompt
  >();

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
        showBashApprovalPrompt: this.showBashApprovalPrompt.bind(this),
        resolveBashApprovalPrompt: this.resolveBashApprovalPrompt.bind(this),
        updateBashApprovalBypassState:
          this.updateBashApprovalBypassState.bind(this),
        showAgentProposal: this.showAgentProposal.bind(this),
        resolveAgentProposal: this.resolveAgentProposal.bind(this),
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
      vscode.window.onDidChangeActiveColorTheme(() => {
        if (this.isViewVisible()) {
          this.updateWebview();
        }
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
    this._sidebarReady = false;
    this._pendingUpdateOptions = null;
  }

  /**
   * Common setup for any webview (sidebar or panel).
   * Sets HTML content and message handler.
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

    return disposables;
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    // Mark running tasks as cancelled on subsequent webview resolves
    if (this._hasResolved) {
      this.resetRunningStreamStatuses();
    }
    this._hasResolved = true;

    this._sidebarReady = false;
    this._pendingUpdateOptions = null;

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

    if (!this.isAnyViewReady()) {
      // Queue the update, preserving forceRebuild if any caller requested it
      const currentForce = this._pendingUpdateOptions?.forceRebuild ?? false;
      this._pendingUpdateOptions = {
        forceRebuild: currentForce || !!options?.forceRebuild,
      };
      return;
    }

    const isDarkTheme =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
    const theme = isDarkTheme ? 'dark' : 'light';

    const activeStream = this.webviewUpdater.updateAll(
      this.state,
      this.eventHandler.getAllStreamStatuses(),
      theme,
    );

    // Frontend detects stream switches using its own lastRenderedStream tracking.
    // Backend just sends data with action: 'render', frontend decides if rebuild needed.
    //
    // Skip refresh when activeStream is empty but streams exist in state - this indicates
    // a temporary filter mismatch (e.g., during resume flow race conditions).
    // Calling refreshStreamSurface('') would send action: 'clear' and wipe the display.
    const hasStreams = this.state.streamTabs.keys().length > 0;
    const isFilterMismatch = !activeStream && hasStreams;
    if (!isFilterMismatch) {
      this.eventHandler.refreshStreamSurface(activeStream);
    }

    // Send YOLO state for the resolved active stream (single source of truth query)
    this.sendYoloStateForStream(activeStream);

    this._pendingUpdateOptions = null;
  }

  /**
   * Send YOLO mode state to the frontend for a stream.
   * When no stream is active, sends false to reset the UI.
   * Sends both tool edit and bash approval YOLO states.
   */
  private sendYoloStateForStream(streamId: StreamTabId): void {
    const toolEditBypassActive = streamId
      ? isApprovalBypassedForStream(streamId)
      : false;
    const bashBypassActive = streamId
      ? isBashApprovalBypassedForStream(streamId)
      : false;
    this.sendIfReady(() => {
      this.webviewUpdater.updateToolEditApprovalState(
        streamId || ('' as StreamTabId),
        toolEditBypassActive,
      );
      this.webviewUpdater.updateBashApprovalState(
        streamId || ('' as StreamTabId),
        bashBypassActive,
      );
    });
  }

  /**
   * Mark the webview as ready and process any pending updates.
   */
  public markWebviewReady(
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): void {
    if (this.isPanelView(view)) {
      this._panelReady = true;
    } else {
      this._sidebarReady = true;
    }

    // Clear pending options - we always force rebuild on first load anyway,
    // and that takes precedence over any pending options.
    this._pendingUpdateOptions = null;
    this.updateWebview({ forceRebuild: true });

    // Replay pending prompts and requests
    this.replayPendingPrompts();
  }

  /**
   * Replay pending approval prompts and retry requests to newly ready webview.
   */
  private replayPendingPrompts(): void {
    if (!this.webviewUpdater.isAvailable()) {
      return;
    }

    for (const prompt of this.pendingApprovalPrompts.values()) {
      this.webviewUpdater.showToolEditApprovalPrompt(prompt);
    }

    for (const prompt of this.pendingBashApprovalPrompts.values()) {
      this.webviewUpdater.showBashApprovalPrompt(prompt);
    }

    // Send per-stream YOLO state for active stream (handles empty stream case)
    this.sendYoloStateForStream(this.state.activeStream);

    for (const payload of this.pendingRetryRequests.values()) {
      this.webviewUpdater.showRetryRequest(payload);
    }

    for (const proposal of this.pendingAgentProposals.values()) {
      this.webviewUpdater.showAgentProposal(proposal);
    }
  }

  public showToolEditApprovalPrompt(prompt: ToolEditApprovalPrompt): void {
    this.pendingApprovalPrompts.set(prompt.requestId, prompt);
    this.sendIfReady(() =>
      this.webviewUpdater.showToolEditApprovalPrompt(prompt),
    );
  }

  public resolveToolEditApprovalPrompt(requestId: string): void {
    this.pendingApprovalPrompts.delete(requestId);
    this.sendIfReady(() =>
      this.webviewUpdater.resolveToolEditApprovalPrompt(requestId),
    );
  }

  public updateToolEditApprovalBypassState(
    streamId: StreamTabId,
    bypassActive: boolean,
  ): void {
    // toolEditApproval.ts is the single source of truth for YOLO state
    // This method just relays the state change to the webview
    this.sendIfReady(() =>
      this.webviewUpdater.updateToolEditApprovalState(streamId, bypassActive),
    );
  }

  public showBashApprovalPrompt(prompt: BashApprovalPrompt): void {
    this.pendingBashApprovalPrompts.set(prompt.requestId, prompt);
    this.sendIfReady(() =>
      this.webviewUpdater.showBashApprovalPrompt(prompt),
    );
  }

  public resolveBashApprovalPrompt(requestId: string): void {
    this.pendingBashApprovalPrompts.delete(requestId);
    this.sendIfReady(() =>
      this.webviewUpdater.resolveBashApprovalPrompt(requestId),
    );
  }

  public updateBashApprovalBypassState(
    streamId: StreamTabId,
    bypassActive: boolean,
  ): void {
    // bashApproval.ts is the single source of truth for bash YOLO state
    // This method just relays the state change to the webview
    this.sendIfReady(() =>
      this.webviewUpdater.updateBashApprovalState(streamId, bypassActive),
    );
  }

  public showRetryRequest(
    payload: ProgressEventPayloads['showRetryRequest'],
  ): void {
    this.pendingRetryRequests.set(payload.streamId, payload);
    this.sendIfReady(() => this.webviewUpdater.showRetryRequest(payload));
  }

  public resolveRetryRequest(streamId: string): void {
    this.pendingRetryRequests.delete(streamId);
    this.sendIfReady(() => this.webviewUpdater.resolveRetryRequest(streamId));
  }

  public showAgentProposal(prompt: AgentProposalPrompt): void {
    this.pendingAgentProposals.set(prompt.proposalId, prompt);
    this.sendIfReady(() => this.webviewUpdater.showAgentProposal(prompt));
  }

  public resolveAgentProposal(proposalId: string): void {
    this.pendingAgentProposals.delete(proposalId);
    this.sendIfReady(() =>
      this.webviewUpdater.resolveAgentProposal(proposalId),
    );
  }

  public getPendingAgentProposal(
    proposalId: string,
  ): AgentProposalPrompt | undefined {
    return this.pendingAgentProposals.get(proposalId);
  }

  /** Send to webview if ready, otherwise skip (pending state will be replayed later) */
  private sendIfReady(send: () => void): void {
    if (this.canSendToWebview()) {
      send();
    }
  }

  /**
   * Check if webview is ready to receive messages.
   * Combines readiness check with availability check.
   */
  private canSendToWebview(): boolean {
    return this.isAnyViewReady() && this.webviewUpdater.isAvailable();
  }

  /**
   * Cleanup tasks after restart (legacy compatibility)
   */
  public async cleanupTasksAfterRestart(
    waitingStreams?: Set<StreamTabId>,
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
    return this._view?.visible === true || this._panelView?.visible === true;
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
    waitingStreams?: Set<StreamTabId>,
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
  public setActiveStream(streamId: StreamTabId): void {
    this.state.activeStream = streamId;
    this.updateWebview();
    // YOLO state is sent by updateWebview via sendYoloStateForStream
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
    this._panelReady = false;

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

    this._panelDisposables.push(
      this._panelView.onDidDispose(() => {
        this.disposePanelResources();
      }),
    );

    // Trigger initial update (webview will send WEBVIEW_READY when loaded)
    this.updateWebview();
  }

  public override dispose(): void {
    // Clean up panel resources
    this.disposePanelResources(true);
    super.dispose();
  }

  private isAnyViewReady(): boolean {
    return this._sidebarReady || this._panelReady;
  }

  private isPanelView(
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): view is vscode.WebviewPanel {
    return 'viewColumn' in view;
  }

  private disposePanelResources(disposeView = false): void {
    const panelView = this._panelView;
    this._panelView = undefined;
    this._panelDisposables.forEach((d) => d.dispose());
    this._panelDisposables = [];
    this._panelReady = false;
    if (disposeView) {
      panelView?.dispose();
    }
  }
}
