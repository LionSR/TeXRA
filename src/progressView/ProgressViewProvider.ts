import * as vscode from 'vscode';

import type { IRunStorageService } from '@agent/runtime/RunStorageService';
import { setRunStorageService } from '@agent/runtime/RunStorageService';
import {
  BaseWebviewProvider,
  getSharedLocalResourceRoots,
} from '@common/webview';
import { AgentLogger } from '@logger/AgentLogger';
import { ApprovalRequestHandler } from '@progressView/managers/ApprovalRequestHandler';
import { WebviewUpdater } from '@progressView/managers/WebviewUpdater';
import { isApprovalBypassedForStream } from '@tools/approval/toolEditApproval';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

import { ProgressEventHandler } from './events/ProgressEventHandler';
import { ProgressViewContentProvider } from './ProgressViewContentProvider';
import { ProgressViewMessageHandler } from './ProgressViewMessageHandler';
import { ProgressViewState } from './state/ProgressViewState';
import type {
  AgentProposalPermission,
  BashPermission,
  OutputFileInfo,
  StorageKey,
  StreamTabId,
  ToolEditPermission,
} from '@shared/schemas';

/**
 * Orchestrates the progress view webview (sidebar and panel).
 * Implements IRunStorageService for agent runtime integration.
 */
export class ProgressViewProvider
  extends BaseWebviewProvider
  implements vscode.WebviewViewProvider, IRunStorageService
{
  public static readonly viewType = 'texra.progressView';
  private static _instance: ProgressViewProvider | undefined;

  public readonly state: ProgressViewState;
  public readonly eventHandler: ProgressEventHandler;
  public readonly webviewUpdater: WebviewUpdater;

  protected readonly contentProvider: ProgressViewContentProvider;
  protected readonly messageHandler: ProgressViewMessageHandler;

  private readonly _viewTitle: string;
  private _sidebarReady = false;
  private _panelReady = false;
  private _panelView?: vscode.WebviewPanel;
  private _panelDisposables: vscode.Disposable[] = [];
  private _pendingUpdateOptions: { forceRebuild: boolean } | null = null;
  private _hasResolved = false;
  private readonly logger: AgentLogger;

  private readonly toolEditHandler: ApprovalRequestHandler<
    ToolEditPermission,
    'requestId'
  >;
  private readonly bashApprovalHandler: ApprovalRequestHandler<
    BashPermission,
    'requestId'
  >;
  private readonly retryRequestHandler: ApprovalRequestHandler<
    ProgressEventPayloads['showRetryRequest'],
    'streamId'
  >;
  private readonly agentProposalHandler: ApprovalRequestHandler<
    AgentProposalPermission,
    'proposalId'
  >;

  constructor(
    protected readonly context: vscode.ExtensionContext,
    title: string = 'Tasks',
  ) {
    super(context);
    this._viewTitle = title;
    this.logger = new AgentLogger('ProgressViewProvider');

    this.state = new ProgressViewState();
    this.webviewUpdater = new WebviewUpdater(() => [
      this._view?.webview,
      this._panelView?.webview,
    ]);

    const canSend = () => this.canSendToWebview();
    const u = this.webviewUpdater;
    this.toolEditHandler = new ApprovalRequestHandler(
      'requestId',
      (p) => u.showToolEditPermission(p),
      (id) => u.resolveToolEditPermission(id),
      canSend,
    );
    this.bashApprovalHandler = new ApprovalRequestHandler(
      'requestId',
      (p) => u.showBashPermission(p),
      (id) => u.resolveBashPermission(id),
      canSend,
    );
    this.retryRequestHandler = new ApprovalRequestHandler(
      'streamId',
      (p) => u.showRetryRequest(p),
      (id) => u.resolveRetryRequest(id),
      canSend,
    );
    this.agentProposalHandler = new ApprovalRequestHandler(
      'proposalId',
      (p) => u.showAgentProposal(p),
      (id) => u.resolveAgentProposal(id),
      canSend,
    );

    this.eventHandler = new ProgressEventHandler(
      this.state,
      this.webviewUpdater,
      {
        showRetryRequest: (p) => this.retryRequestHandler.show(p),
        resolveRetryRequest: (id) => this.retryRequestHandler.resolve(id),
        showToolEditPermission: (p) => this.toolEditHandler.show(p),
        resolveToolEditPermission: (id) => this.toolEditHandler.resolve(id),
        updateToolEditApprovalBypassState: (streamId, bypassActive) => {
          if (canSend())
            u.updateToolEditApprovalState(
              streamId as StreamTabId,
              bypassActive,
            );
        },
        showBashPermission: (p) => this.bashApprovalHandler.show(p),
        resolveBashPermission: (id) => this.bashApprovalHandler.resolve(id),
        showAgentProposal: (p) => this.agentProposalHandler.show(p),
        resolveAgentProposal: (id) => this.agentProposalHandler.resolve(id),
      },
    );

    this.contentProvider = new ProgressViewContentProvider(context);
    this.messageHandler = new ProgressViewMessageHandler(this, context);

    ProgressViewProvider._instance = this;
    setRunStorageService(this);

    this._disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        await this.state.load();
        this.updateWebview({ forceRebuild: true });
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        if (this.isViewVisible()) {
          this.updateWebview();
        }
      }),
    );
  }

  public async initialize(): Promise<void> {
    await this.state.load();
    this._disposables.push(...this.eventHandler.setupEventListeners());
    this.logger.debug('ProgressViewProvider initialized');
  }

  public static getInstance(): ProgressViewProvider | undefined {
    return this._instance;
  }

  protected override cleanupView(): void {
    super.cleanupView();
    this._sidebarReady = false;
    this._pendingUpdateOptions = null;
  }

  private setupWebviewContent(
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];

    view.webview.html = this.contentProvider.getHtmlContent(view.webview);

    disposables.push(
      view.webview.onDidReceiveMessage((message) =>
        this.messageHandler.handleMessage(message, view),
      ),
    );

    return disposables;
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
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

    this.cleanupView();
    this._view = webviewView;

    const disposables = this.setupWebviewContent(webviewView);
    this._viewDisposables.push(...disposables);

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

  public updateWebview(options?: { forceRebuild?: boolean }): void {
    if (!this._view && !this._panelView) return;

    if (!this.isAnyViewReady()) {
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

    const hasStreams = this.state.streamTabs.keys().length > 0;
    const isFilterMismatch = !activeStream && hasStreams;
    if (!isFilterMismatch) {
      this.eventHandler.refreshStreamSurface(activeStream);
    }

    this.sendYoloStateForStream(activeStream);

    this._pendingUpdateOptions = null;
  }

  private sendYoloStateForStream(streamId: StreamTabId): void {
    if (!this.canSendToWebview()) return;
    const bypassActive = streamId
      ? isApprovalBypassedForStream(streamId)
      : false;
    this.webviewUpdater.updateToolEditApprovalState(
      streamId || ('' as StreamTabId),
      bypassActive,
    );
  }

  public markWebviewReady(
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): void {
    if (this.isPanelView(view)) {
      this._panelReady = true;
    } else {
      this._sidebarReady = true;
    }

    this._pendingUpdateOptions = null;
    this.updateWebview({ forceRebuild: true });
    this.replayPendingPrompts();
  }

  private replayPendingPrompts(): void {
    if (!this.webviewUpdater.isAvailable()) {
      return;
    }

    this.toolEditHandler.replay();
    this.bashApprovalHandler.replay();
    this.sendYoloStateForStream(this.state.activeStream);

    this.retryRequestHandler.replay();
    this.agentProposalHandler.replay();
  }

  public getPendingAgentProposal(
    proposalId: string,
  ): AgentProposalPermission | undefined {
    return this.agentProposalHandler.get(proposalId);
  }

  private canSendToWebview(): boolean {
    return this.isAnyViewReady() && this.webviewUpdater.isAvailable();
  }

  public async cleanupTasksAfterRestart(
    waitingStreams?: Set<StreamTabId>,
  ): Promise<void> {
    await this.resetRunningStreamStatuses(waitingStreams);
    this.updateWebview({ forceRebuild: true });
  }

  public isViewVisible(): boolean {
    return this._view?.visible === true || this._panelView?.visible === true;
  }

  public getActiveRunId(stream: StreamTabId): StorageKey | null {
    return this.state.getActiveRunId(stream);
  }

  public getRunOutputFiles(
    stream: StreamTabId,
    options: { storageKey: StorageKey },
  ): Map<number, OutputFileInfo[]> | undefined {
    return this.state.getRunOutputFiles(stream, options);
  }

  private async resetRunningStreamStatuses(
    waitingStreams?: Set<StreamTabId>,
  ): Promise<void> {
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

  public setActiveStream(streamId: StreamTabId): void {
    this.state.activeStream = streamId;
    this.updateWebview();
  }

  public showProgressViewAsPanel(): void {
    if (this._panelView) {
      this._panelView.reveal(vscode.ViewColumn.One);
      this.updateWebview({ forceRebuild: true });
      return;
    }

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

    this._panelDisposables.push(...this.setupWebviewContent(this._panelView));

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

    this.updateWebview();
  }

  public override dispose(): void {
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
