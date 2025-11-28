// Third-party imports
import * as vscode from 'vscode';

// Internal imports
import { BaseWebviewProvider } from '@common/webview';
import { getSharedLocalResourceRoots } from '@common/webview';
import { AgentLogger } from '@logger/AgentLogger';

// Local file imports
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import { ProgressEventHandler } from './events/ProgressEventHandler';
import { WebviewUpdater } from './managers';
// @ts-ignore - Import JavaScript module
import { ProgressViewContentProvider } from './ProgressViewContentProvider';
import { ProgressViewMessageHandler } from './ProgressViewMessageHandler';
import { ProgressViewState } from './state/ProgressViewState';

// Types

// Type imports
import type { ToolEditApprovalPrompt } from './types';

/**
 * Refactored ProgressViewProvider using the new modular architecture.
 * This class now focuses on orchestration and delegation to focused managers,
 * following the design principles from AGENTS.md.
 */
export class ProgressViewProvider
  extends BaseWebviewProvider
  implements vscode.WebviewViewProvider
{
  private static _instance: ProgressViewProvider | undefined;

  // New modular architecture components
  public readonly state: ProgressViewState;
  public readonly eventHandler: ProgressEventHandler;
  public readonly webviewUpdater: WebviewUpdater;

  // Existing components (will be gradually updated)
  protected readonly contentProvider: ProgressViewContentProvider;
  protected readonly messageHandler: ProgressViewMessageHandler;

  // Infrastructure
  private readonly _extensionUri: vscode.Uri;
  private readonly _viewTitle: string;
  private _webviewReady = false;
  private _pendingUpdate = false;
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
    this._extensionUri = context.extensionUri;
    this._viewTitle = title;
    this.logger = new AgentLogger('ProgressViewProvider');

    // Initialize new modular architecture
    this.state = new ProgressViewState();
    this.webviewUpdater = new WebviewUpdater(() => this._view?.webview);
    this.eventHandler = new ProgressEventHandler(
      this.state,
      this.webviewUpdater,
      {
        showRetryRequest: (payload) => this.showRetryRequest(payload),
        resolveRetryRequest: (streamId) => this.resolveRetryRequest(streamId),
      },
    );

    // Initialize existing components
    this.contentProvider = new ProgressViewContentProvider(context);
    this.messageHandler = new ProgressViewMessageHandler(this, context);

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
    this._pendingUpdate = false;
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    // Mark running tasks as cancelled on subsequent webview resolves
    if (this._hasResolved) {
      this.resetRunningStreamStatuses();
    }
    this._hasResolved = true;

    this._webviewReady = false;
    this._pendingUpdate = false;
    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
      localResourceRoots: getSharedLocalResourceRoots(
        this.context,
        'progressView',
      ),
    };

    webviewView.title = this._viewTitle;

    // Call super first to set up base functionality and clean up old disposables
    super.resolveWebviewViewInternal(webviewView);

    // Add visibility and theme listeners after super.resolveWebviewView
    // This ensures they aren't cleared by the base class's cleanupView()
    this.addViewDisposables(
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
    );

    this.updateWebview();
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

    const theme =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
        ? 'dark'
        : 'light';

    const activeStream = this.webviewUpdater.updateAll(
      this.state,
      this.eventHandler.getAllStreamStatuses(),
      theme,
    );

    this.eventHandler.refreshStreamSurface(activeStream || '');

    this._pendingUpdate = false;
  }

  /**
   * Mark the webview as ready and process any pending updates.
   */
  public markWebviewReady(): void {
    this._webviewReady = true;
    this.updateWebview();

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
   * Update log content for a stream (used by message handler)
   * Now properly focused on just updating log content with groups
   */
  public updateLogContent(stream: string): void {
    if (!this.webviewUpdater.isAvailable()) {
      return;
    }

    const targetStream = this.state.streamTabs.has(stream)
      ? stream
      : (this.state.streamTabs.keys()[0] ?? '');

    if (!targetStream) {
      this.webviewUpdater.updateLogContent('', [], []);
      return;
    }

    this.eventHandler.refreshStreamSurface(targetStream, {
      updateInstruction: false,
    });
  }

  /**
   * Set active stream (used by message handler)
   */
  public setActiveStream(stream: string): void {
    this.state.activeStream = stream;
    this.updateWebview();
  }
}
