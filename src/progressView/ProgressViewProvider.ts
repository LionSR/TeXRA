import * as vscode from 'vscode';

import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import type { IRunStorageService } from '@agent/runtime/RunStorageService';
import { setRunStorageService } from '@agent/runtime/RunStorageService';
import {
  BaseWebviewProvider,
  getSharedLocalResourceRoots,
  SIDEBAR_VIEWS,
  setActiveSidebarView,
} from '@common/webview';
import { AgentLogger } from '@logger/AgentLogger';
import {
  buildBasicModelOptionsData,
  computeModelOptionsData,
} from '@model/computeModelOptions';
import { ApprovalRequestHandler } from '@progressView/managers/ApprovalRequestHandler';
import { WebviewBridge } from '@progressView/managers/WebviewBridge';
import { WebviewUpdater } from '@progressView/managers/WebviewUpdater';
import { isApprovalBypassedForStream } from '@tools/approval/toolEditApproval';
import { isProposalBypassedForStream } from '@tools/approval/proposalApproval';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

import { ProgressEventHandler } from './events/ProgressEventHandler';
import { ProgressViewContentProvider } from './ProgressViewContentProvider';
import { ProgressViewMessageHandler } from './ProgressViewMessageHandler';
import { ProgressViewState } from './state/ProgressViewState';
import type {
  AgentProposalPermission,
  BashPermission,
  ModelOptionData,
  OutputFileInfo,
  ProgressViewPlacement,
  StorageKey,
  StreamTabId,
  ToolEditPermission,
} from '@shared/schemas';

import type { MainViewProvider } from '../MainViewProvider';

/**
 * Orchestrates the progress view webview with exclusive rendering:
 * sidebar OR editor panel, never both as active targets.
 *
 * In sidebar mode, the single `texra.mainView` hosts progress content —
 * MainViewProvider owns the WebviewView and delegates messages here.
 *
 * Implements IRunStorageService for agent runtime integration.
 */
export class ProgressViewProvider
  extends BaseWebviewProvider
  implements IRunStorageService
{
  public static readonly viewType = 'texra.progressView';
  private static _instance: ProgressViewProvider | undefined;

  public readonly state: ProgressViewState;
  public readonly eventHandler: ProgressEventHandler;
  public readonly webviewBridge: WebviewBridge;
  public readonly webviewUpdater: WebviewUpdater;

  protected readonly contentProvider: ProgressViewContentProvider;
  protected readonly messageHandler: ProgressViewMessageHandler;

  private _sidebarReady = false;
  private _panelReady = false;
  private _panelView?: vscode.WebviewPanel;
  private _panelDisposables: vscode.Disposable[] = [];
  private _activePlacement: ProgressViewPlacement = 'sidebar';
  private _pendingUpdateOptions: { forceRebuild: boolean } | null = null;
  private readonly logger: AgentLogger;

  /** Getter provided by MainViewProvider — returns its webview when in sidebar mode. */
  private _sidebarWebviewGetter?: () => vscode.Webview | undefined;
  /** Reference to MainViewProvider for mode switching. */
  private _mainViewProvider?: MainViewProvider;

  /** TTL-cached model options to avoid redundant async work for rapid proposals. */
  private static readonly MODEL_OPTIONS_TTL_MS = 30_000;
  private _cachedModelOptions?: {
    data: ModelOptionData[];
    expiry: number;
  };

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

  constructor(protected readonly context: vscode.ExtensionContext) {
    super(context);
    this.logger = new AgentLogger('ProgressViewProvider');

    this.state = new ProgressViewState();
    this.webviewUpdater = new WebviewUpdater(() => [this.getActiveWebview()]);
    this.webviewBridge = new WebviewBridge(
      this.state.streamLogs,
      () => [this.getActiveWebview()],
      () => {
        const active = this.state.activeStream;
        return active || null;
      },
    );

    const canSend = () => this.canSendToWebview();
    const u = this.webviewUpdater;
    this.toolEditHandler = new ApprovalRequestHandler(
      'requestId',
      (p) => u.showPermission({ kind: PERMISSION_KIND.TOOL_EDIT, data: p }),
      (id) => u.resolvePermission(PERMISSION_KIND.TOOL_EDIT, id),
      canSend,
    );
    this.bashApprovalHandler = new ApprovalRequestHandler(
      'requestId',
      (p) => u.showPermission({ kind: PERMISSION_KIND.BASH, data: p }),
      (id) => u.resolvePermission(PERMISSION_KIND.BASH, id),
      canSend,
    );
    this.retryRequestHandler = new ApprovalRequestHandler(
      'streamId',
      (p) => u.showPermission({ kind: PERMISSION_KIND.RETRY, data: p }),
      (id) => u.resolvePermission(PERMISSION_KIND.RETRY, id),
      canSend,
    );
    this.agentProposalHandler = new ApprovalRequestHandler(
      'proposalId',
      (p) => {
        // Show proposal immediately with basic model dropdown (synchronous)
        u.showPermission({
          kind: PERMISSION_KIND.PROPOSAL,
          data: p,
          modelOptionsData: buildBasicModelOptionsData(),
        });
        // Then upgrade with availability metadata if possible
        void this.sendProposalModelOptions(p);
      },
      (id) => u.resolvePermission(PERMISSION_KIND.PROPOSAL, id),
      canSend,
    );

    this.eventHandler = new ProgressEventHandler(
      this.state,
      this.webviewUpdater,
      this.webviewBridge,
      {
        showRetryRequest: (p) => this.retryRequestHandler.show(p),
        resolveRetryRequest: (id) => this.retryRequestHandler.resolve(id),
        showToolEditPermission: (p) => this.toolEditHandler.show(p),
        resolveToolEditPermission: (id) => this.toolEditHandler.resolve(id),
        updateToolEditApprovalBypassState: (streamId, bypassActive) => {
          if (canSend())
            u.updateBypassState(
              streamId as StreamTabId,
              'toolEdit',
              bypassActive,
            );
        },
        updateSuperYoloBypassState: (streamId, bypassActive) => {
          if (canSend())
            u.updateBypassState(
              streamId as StreamTabId,
              'superYolo',
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
        this.syncFullView({ forceRebuild: true });
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        if (this.isViewVisible()) {
          this.syncFullView();
        }
      }),
    );
  }

  public async initialize(): Promise<void> {
    await this.state.load();
    this._disposables.push(...this.eventHandler.setupEventListeners());
    this.logger.debug('ProgressViewProvider initialized');
  }

  // --- Wiring from extension.ts ---

  public setSidebarWebviewGetter(
    getter: () => vscode.Webview | undefined,
  ): void {
    this._sidebarWebviewGetter = getter;
  }

  public setMainViewProvider(mvp: MainViewProvider): void {
    this._mainViewProvider = mvp;
  }

  /** Expose content provider so MainViewProvider can render progress HTML. */
  public getContentProvider(): ProgressViewContentProvider {
    return this.contentProvider;
  }

  /**
   * Called by MainViewProvider when it receives a message while in progress mode.
   * Routes to the progress view message handler.
   */
  public handleSidebarMessage(
    message: unknown,
    view: vscode.WebviewView,
  ): void {
    void this.messageHandler.handleMessage(message, view);
  }

  /** Called by MainViewProvider when switching away from progress mode. */
  public resetSidebarReady(): void {
    this._sidebarReady = false;
    this._pendingUpdateOptions = null;
  }

  /**
   * Load model options and re-send the proposal with the dropdown data.
   * Sent as a second SHOW message — the frontend upserts it over the initial
   * (model-option-less) permission.
   *
   * Guards against the RESOLVE-between-two-SHOWs race: if the user
   * approves/rejects while model options are loading, the proposal is
   * removed from agentProposalHandler. We check before sending so the
   * late SHOW doesn't re-create an undismissable ghost proposal.
   *
   * Uses a 30-second TTL cache to avoid redundant async work when
   * multiple proposals arrive in quick succession.
   */
  private async sendProposalModelOptions(
    proposal: AgentProposalPermission,
  ): Promise<void> {
    let modelOptions: ModelOptionData[];
    try {
      modelOptions = await this.getCachedModelOptions();
    } catch {
      // Availability check failed (e.g. ServerSideKeyService not yet initialized) —
      // fall back to static model metadata so the dropdown still appears.
      modelOptions = buildBasicModelOptionsData();
    }
    if (!this.agentProposalHandler.get(proposal.proposalId)) return;
    this.webviewUpdater.showPermission({
      kind: PERMISSION_KIND.PROPOSAL,
      data: proposal,
      modelOptionsData: modelOptions,
    });
  }

  private async getCachedModelOptions(): Promise<ModelOptionData[]> {
    const now = Date.now();
    if (this._cachedModelOptions && now < this._cachedModelOptions.expiry) {
      return this._cachedModelOptions.data;
    }
    const data = await computeModelOptionsData();
    this._cachedModelOptions = {
      data,
      expiry: now + ProgressViewProvider.MODEL_OPTIONS_TTL_MS,
    };
    return data;
  }

  public static getInstance(): ProgressViewProvider | undefined {
    return this._instance;
  }

  private setupWebviewContent(
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): vscode.Disposable {
    view.webview.html = this.contentProvider.getHtmlContent(view.webview);
    return view.webview.onDidReceiveMessage((message) =>
      this.messageHandler.handleMessage(message, view),
    );
  }

  public syncFullView(options?: { forceRebuild?: boolean }): void {
    if (!this.getActiveWebview() && !this._panelView) return;

    if (!this.isActivePlacementReady()) {
      const currentForce = this._pendingUpdateOptions?.forceRebuild ?? false;
      this._pendingUpdateOptions = {
        forceRebuild: currentForce || !!options?.forceRebuild,
      };
      return;
    }

    const isDarkTheme =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
    const theme = isDarkTheme ? 'dark' : 'light';

    this.webviewUpdater.setPlacement(this._activePlacement);

    const activeStream = this.webviewUpdater.sendStreamMetadata(
      this.state,
      this.eventHandler.getAllStreamStatuses(),
      theme,
    );

    const hasStreams = this.state.streamLogs.keys().length > 0;
    const isFilterMismatch = !activeStream && hasStreams;
    if (!isFilterMismatch) {
      this.eventHandler.syncStreamContent(activeStream);
    }

    this._pendingUpdateOptions = null;

    // Send YOLO/Super YOLO bypass state for the active stream
    if (this.canSendToWebview()) {
      this.sendBypassStates(activeStream || ('' as StreamTabId));
    }
  }

  public markWebviewReady(
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): void {
    if (this.isPanelView(view)) {
      this._panelReady = true;
    } else {
      this._sidebarReady = true;
    }

    if (!this.isViewActiveTarget(view)) {
      return;
    }

    this._pendingUpdateOptions = null;
    this.syncFullView({ forceRebuild: true });
    this.replayPendingPrompts();
  }

  private replayPendingPrompts(): void {
    if (!this.webviewUpdater.isAvailable()) {
      return;
    }

    this.toolEditHandler.replay();
    this.bashApprovalHandler.replay();
    // YOLO / Super YOLO state is already sent by syncFullView() which is
    // always called before replayPendingPrompts() in markWebviewReady().

    this.retryRequestHandler.replay();
    this.agentProposalHandler.replay();
  }

  public getPendingAgentProposal(
    proposalId: string,
  ): AgentProposalPermission | undefined {
    return this.agentProposalHandler.get(proposalId);
  }

  private canSendToWebview(): boolean {
    return this.isActivePlacementReady() && this.webviewUpdater.isAvailable();
  }

  /** Send YOLO / Super YOLO bypass state for a given stream. */
  private sendBypassStates(streamId: StreamTabId): void {
    this.webviewUpdater.updateBypassState(
      streamId,
      'toolEdit',
      isApprovalBypassedForStream(streamId),
    );
    this.webviewUpdater.updateBypassState(
      streamId,
      'superYolo',
      isProposalBypassedForStream(streamId),
    );
  }

  public async cleanupTasksAfterRestart(
    waitingStreams?: Set<StreamTabId>,
  ): Promise<void> {
    await this.resetRunningStreamStatuses(waitingStreams);
    this.syncFullView({ forceRebuild: true });
  }

  public isViewVisible(): boolean {
    if (this._activePlacement === 'editor') {
      return this._panelView?.visible === true;
    }
    // Sidebar mode: check MainViewProvider's mode and the webview view visibility
    if (this._mainViewProvider) {
      const webviewView = this._mainViewProvider.getWebviewView();
      return (
        this._mainViewProvider.getActiveMode() === 'progress' &&
        webviewView?.visible === true
      );
    }
    return false;
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

    const streamsWithRunningGroups = await this.state.endRunningTaskGroups(
      Date.now(),
    );

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

    if (!this.canSendToWebview()) return;

    this.webviewUpdater.setActiveStream(streamId);
    this.sendBypassStates(streamId);
    // Hydrate content (logs, todos, follow-ups, instruction) + active-state metadata
    this.eventHandler.syncStreamContent(streamId, { includeActiveState: true });
  }

  public isEditorMode(): boolean {
    return this._activePlacement === 'editor' && this._panelView !== undefined;
  }

  public async showInSidebar(options?: { inPlace?: boolean }): Promise<void> {
    this._activePlacement = 'sidebar';

    if (this._mainViewProvider) {
      await this._mainViewProvider.switchMode('progress');
      if (!options?.inPlace) {
        await vscode.commands.executeCommand('texra.mainView.focus');
      }
    } else {
      // Fallback: just set context key
      await setActiveSidebarView(SIDEBAR_VIEWS.PROGRESS);
    }

    if (this.isActivePlacementReady()) {
      this.syncFullView({ forceRebuild: true });
      this.replayPendingPrompts();
    }
  }

  public async showProgressView(options?: {
    inPlace?: boolean;
  }): Promise<void> {
    if (this.isEditorMode()) {
      this.revealEditorPanel();
      if (this.isActivePlacementReady()) {
        this.syncFullView({ forceRebuild: true });
      }
      return;
    }
    await this.showInSidebar(options);
  }

  public revealEditorPanel(): void {
    if (this._panelView) {
      this._panelView.reveal(vscode.ViewColumn.One);
    }
  }

  public async popOutToEditor(): Promise<void> {
    if (this._panelView) {
      this._activePlacement = 'editor';
      // Restore sidebar to launcher mode
      if (this._mainViewProvider) {
        await this._mainViewProvider.switchMode('main');
      } else {
        await setActiveSidebarView(SIDEBAR_VIEWS.MAIN);
      }
      this.revealEditorPanel();
      this.syncFullView({ forceRebuild: true });
      this.replayPendingPrompts();
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

    this._panelDisposables.push(
      this.setupWebviewContent(this._panelView),
      this._panelView.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) {
          this.syncFullView();
        }
      }),
      this._panelView.onDidDispose(() => {
        this.disposePanelResources();
      }),
    );

    this._activePlacement = 'editor';
    // Restore sidebar to launcher mode
    if (this._mainViewProvider) {
      await this._mainViewProvider.switchMode('main');
    } else {
      await setActiveSidebarView(SIDEBAR_VIEWS.MAIN);
    }
  }

  public showProgressViewAsPanel(): void {
    void this.popOutToEditor();
  }

  public async popBackToSidebar(): Promise<void> {
    this.disposePanelResources(true);
    await this.showInSidebar();
  }

  public async flushState(): Promise<void> {
    await this.state.flush();
  }

  public override dispose(): void {
    this.disposePanelResources(true);
    this.webviewBridge.dispose();
    super.dispose();
  }

  private isActivePlacementReady(): boolean {
    return this._activePlacement === 'editor'
      ? this._panelReady
      : this._sidebarReady;
  }

  private getActiveWebview(): vscode.Webview | undefined {
    if (this._activePlacement === 'editor') {
      return this._panelView?.webview;
    }
    // Sidebar mode: use the getter from MainViewProvider
    return this._sidebarWebviewGetter?.();
  }

  private isViewActiveTarget(
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): boolean {
    const placement: ProgressViewPlacement = this.isPanelView(view)
      ? 'editor'
      : 'sidebar';
    return placement === this._activePlacement;
  }

  private isPanelView(
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): view is vscode.WebviewPanel {
    return 'viewColumn' in view;
  }

  private disposePanelResources(disposeView = false): void {
    const panelView = this._panelView;
    this._panelView = undefined;
    for (const d of this._panelDisposables) d.dispose();
    this._panelDisposables = [];
    this._panelReady = false;
    if (this._activePlacement === 'editor') {
      this._activePlacement = 'sidebar';
    }
    if (disposeView) {
      panelView?.dispose();
    }
  }
}
