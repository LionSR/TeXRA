import * as vscode from 'vscode';

import { computeAgentOptionsData } from '@agent/index';
import type { IRunStorageService } from '@agent/runtime/RunStorageService';
import { setRunStorageService } from '@agent/runtime/RunStorageService';
import { detectWaitingStreams } from '@agent/storage/detectWaitingStreams';
import {
  BaseWebviewProvider,
  getSharedLocalResourceRoots,
  SIDEBAR_VIEWS,
  setActiveSidebarView,
} from '@common/webview';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import { AgentLogger } from '@logger/AgentLogger';
import { buildBasicModelOptionsData } from '@model/modelOptionsBasic';
import { computeModelOptionsData } from '@model/computeModelOptions';
import { ApprovalRequestHandler } from '@progressView/managers/ApprovalRequestHandler';
import { WebviewBridge } from '@progressView/managers/WebviewBridge';
import { WebviewUpdater } from '@progressView/managers/WebviewUpdater';
import type {
  AgentProposalPermission,
  BashPermission,
  ExternalInquiryPermission,
  PlanApprovalPermission,
  ProgressViewPlacement,
  StorageKey,
  StreamTabId,
  ToolEditPermission,
} from '@shared/schemas';
import { AGENT_CATEGORY } from '@shared/schemas';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { collectKnownSessionLinks } from '@tools/inquiry/externalInquiryResultFormatter';
import {
  getOpenTurnDraft,
  listThreadsByStatus,
  listOpenThreads,
  manifestToTranscript,
  readExternalInquiryThread,
} from '@tools/inquiry/externalInquiryStorage';

import { ProgressEventHandler } from './events/ProgressEventHandler';
import { ProgressViewContentProvider } from './ProgressViewContentProvider';
import { ProgressViewMessageHandler } from './ProgressViewMessageHandler';
import { ProgressViewState } from './state/ProgressViewState';

import type { MainViewProvider } from '../MainViewProvider';

const MAX_INQUIRY_THREAD_HYDRATION = 100;

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
  public static readonly viewType = 'texra.progress';
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
  /** Set by disposePanelResources so showInSidebar knows replay is needed. */
  private _panelJustDisposed = false;
  private _pendingUpdateOptions: { forceRebuild: boolean } | null = null;
  private readonly logger: AgentLogger;

  private _sidebarWebviewGetter?: () => vscode.Webview | undefined;
  private _mainViewProvider?: MainViewProvider;

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
  private readonly planApprovalHandler: ApprovalRequestHandler<
    PlanApprovalPermission,
    'approvalId'
  >;
  private readonly externalInquiryHandler: ApprovalRequestHandler<
    ExternalInquiryPermission,
    'requestId'
  >;
  private readonly userQuestionHandler: ApprovalRequestHandler<
    ProgressEventPayloads['showUserQuestion'],
    'requestId'
  >;

  constructor(protected readonly context: vscode.ExtensionContext) {
    super(context);
    this.logger = new AgentLogger('ProgressViewProvider');

    this.state = new ProgressViewState();
    this.webviewUpdater = new WebviewUpdater(() => [this.getActiveWebview()]);
    this.webviewBridge = new WebviewBridge(
      this.state.streamLogs,
      () => [this.getActiveWebview()],
      () => this.state.activeStream || null,
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
    this.planApprovalHandler = new ApprovalRequestHandler(
      'approvalId',
      (p) => u.showPermission({ kind: PERMISSION_KIND.PLAN_APPROVAL, data: p }),
      (id) => u.resolvePermission(PERMISSION_KIND.PLAN_APPROVAL, id),
      canSend,
    );
    this.externalInquiryHandler = new ApprovalRequestHandler(
      'requestId',
      (p) =>
        u.showPermission({
          kind: PERMISSION_KIND.EXTERNAL_INQUIRY,
          data: p,
        }),
      (id) => u.resolvePermission(PERMISSION_KIND.EXTERNAL_INQUIRY, id),
      canSend,
    );
    this.userQuestionHandler = new ApprovalRequestHandler(
      'requestId',
      (p) =>
        u.showPermission({
          kind: PERMISSION_KIND.USER_QUESTION,
          data: p,
        }),
      (id) => u.resolvePermission(PERMISSION_KIND.USER_QUESTION, id),
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
            u.updateBypassState(streamId, 'toolEdit', bypassActive);
        },
        updateSuperYoloBypassState: (streamId, bypassActive) => {
          if (canSend())
            u.updateBypassState(streamId, 'superYolo', bypassActive);
        },
        showBashPermission: (p) => this.bashApprovalHandler.show(p),
        resolveBashPermission: (id) => this.bashApprovalHandler.resolve(id),
        showAgentProposal: (p) => this.agentProposalHandler.show(p),
        resolveAgentProposal: (id) => this.agentProposalHandler.resolve(id),
        showPlanApproval: (p) => this.planApprovalHandler.show(p),
        resolvePlanApproval: (id) => this.planApprovalHandler.resolve(id),
        showExternalInquiry: (p) => this.externalInquiryHandler.show(p),
        resolveExternalInquiry: (id) => this.externalInquiryHandler.resolve(id),
        showUserQuestion: (p) => this.userQuestionHandler.show(p),
        resolveUserQuestion: (id) => this.userQuestionHandler.resolve(id),
      },
      (streamId) => this.hasPendingPermissionsForStream(streamId),
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

  public getContentProvider(): ProgressViewContentProvider {
    return this.contentProvider;
  }

  /** Routes a sidebar message to the progress view message handler. */
  public handleSidebarMessage(
    message: unknown,
    view: vscode.WebviewView,
  ): void {
    void this.messageHandler.handleMessage(message, view);
  }

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
    // Model options have a static fallback (buildBasicModelOptionsData) so
    // the dropdown still appears if ServerSideKeyService isn't ready. Agent
    // options have no static equivalent, so the agent dropdown is omitted
    // when the registry fetch fails.
    const isWorkflow = proposal.agentCategory === AGENT_CATEGORY.WORKFLOW;
    const loadAgentOptions = async () => {
      const all = await computeAgentOptionsData();
      const raw = isWorkflow ? all.workflow : all.toolUse;
      // proposal.agent is a plain name (not source/name), so use label as value.
      return raw.map((opt) => ({ ...opt, value: opt.label }));
    };
    const [modelOptions, agentOptions] = await Promise.all([
      computeModelOptionsData().catch(() => buildBasicModelOptionsData()),
      loadAgentOptions().catch(() => undefined),
    ]);
    if (!this.agentProposalHandler.get(proposal.proposalId)) return;
    this.webviewUpdater.showPermission({
      kind: PERMISSION_KIND.PROPOSAL,
      data: proposal,
      modelOptionsData: modelOptions,
      agentOptionsData: agentOptions,
    });
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
    if (!this.getActiveWebview()) return;

    if (!this.isActivePlacementReady()) {
      const currentForce = this._pendingUpdateOptions?.forceRebuild ?? false;
      this._pendingUpdateOptions = {
        forceRebuild: currentForce || !!options?.forceRebuild,
      };
      return;
    }

    const theme =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
        ? 'dark'
        : 'light';

    this.webviewUpdater.setPlacement(this._activePlacement);

    const activeStream = this.webviewUpdater.sendStreamMetadata(
      this.state,
      this.eventHandler.getAllStreamStatuses(),
      theme,
    );

    // Skip content sync when streams exist but filter excludes all of them
    const hasStreams = this.state.streamLogs.keys().length > 0;
    if (activeStream || !hasStreams) {
      // If the active stream's entries were released (e.g. filter change
      // moved active to a previously-evicted stream), rehydrate before
      // syncing so the webview doesn't render an empty log. Fall back to
      // an immediate sync when the log is already resident.
      if (activeStream && !this.state.streamLogs.get(activeStream)) {
        void this.state.streamLogs.ensureLoaded(activeStream).then(() => {
          if (this.state.activeStream !== activeStream) return;
          this.eventHandler.syncStreamContent(activeStream);
        });
      } else {
        this.eventHandler.syncStreamContent(activeStream);
      }
    }

    this._pendingUpdateOptions = null;
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
    this._panelJustDisposed = false;
    this.syncFullView({ forceRebuild: true });
    // Manifest-backed open inquiries must be re-shown after a full
    // extension reload — ApprovalRequestHandler.pending is in-memory and
    // empty at construction. Fire-and-forget: the replay below covers
    // anything already in-memory; this fills in the durable rows.
    void this.syncInquiryThreads();
    void this.hydrateOpenInquiries();
    this.replayPendingPrompts();
  }

  private async syncInquiryThreads(): Promise<void> {
    if (!this.webviewUpdater.isAvailable()) return;

    try {
      const threads = await listThreadsByStatus({
        status: 'any',
        scope: 'all',
        limit: MAX_INQUIRY_THREAD_HYDRATION,
      });
      this.webviewUpdater.syncInquiryThreads(threads);
    } catch {
      // A damaged manifest should not prevent the progress view from
      // showing streams or replaying pending request panels.
    }
  }

  /**
   * Read every open inquiry thread from durable storage and re-emit
   * its `showExternalInquiry` payload so the panel reappears after an
   * extension reload. No-op when the webview can't accept messages or
   * when in-memory `pending` already covers everything (a sidebar
   * toggle, not a fresh reload). `show()` itself is idempotent on
   * `requestId` via `delivered`, so this gate is a perf optimization,
   * not a correctness fix.
   */
  private async hydrateOpenInquiries(): Promise<void> {
    if (!this.webviewUpdater.isAvailable()) return;
    if (this.externalInquiryHandler.pendingSize > 0) return;

    let open;
    try {
      open = await listOpenThreads();
    } catch {
      return;
    }

    for (const summary of open) {
      try {
        const manifest = await readExternalInquiryThread(summary.threadId);
        if (!manifest || manifest.status !== 'open') continue;
        if (!manifest.parentStreamId) continue;
        const lastTurn = manifest.turns.at(-1);
        if (!lastTurn || lastTurn.answer) continue;
        this.externalInquiryHandler.show({
          requestId: manifest.threadId,
          threadId: manifest.threadId,
          question: lastTurn.question,
          context: lastTurn.context ?? undefined,
          suggestSearch: lastTurn.suggestSearch ?? undefined,
          attachFiles: lastTurn.attachFiles ?? undefined,
          sessionLinks: collectKnownSessionLinks(manifest),
          draft: getOpenTurnDraft(manifest),
          transcript: manifestToTranscript(manifest),
          allowBypass: false,
          streamId: manifest.parentStreamId,
        });
      } catch {
        // Skip threads whose manifest can't be read; surface logs elsewhere.
      }
    }
  }

  private replayPendingPrompts(): void {
    if (!this.webviewUpdater.isAvailable()) {
      return;
    }

    this.toolEditHandler.replay();
    this.bashApprovalHandler.replay();
    this.externalInquiryHandler.replay();
    // YOLO / Super YOLO state is already sent by syncFullView() which is
    // always called before replayPendingPrompts() in markWebviewReady().

    this.retryRequestHandler.replay();
    this.agentProposalHandler.replay();
    this.planApprovalHandler.replay();
  }

  public getPendingAgentProposal(
    proposalId: string,
  ): AgentProposalPermission | undefined {
    return this.agentProposalHandler.get(proposalId);
  }

  /**
   * Check if a stream has any pending approval requests (tool-edit, bash,
   * retry, proposal, or plan approval) that require user interaction.
   */
  public hasPendingPermissionsForStream(streamId: string): boolean {
    return (
      this.retryRequestHandler.hasPendingForStream(streamId) ||
      this.toolEditHandler.hasPendingForStream(streamId) ||
      this.bashApprovalHandler.hasPendingForStream(streamId) ||
      this.agentProposalHandler.hasPendingForStream(streamId) ||
      this.planApprovalHandler.hasPendingForStream(streamId) ||
      this.externalInquiryHandler.hasPendingForStream(streamId) ||
      this.userQuestionHandler.hasPendingForStream(streamId)
    );
  }

  private canSendToWebview(): boolean {
    return this.isActivePlacementReady() && this.webviewUpdater.isAvailable();
  }

  public async cleanupTasksAfterRestart(): Promise<void> {
    const waitingStreams = await detectWaitingStreams(
      this.state.meta.getExecutionIdMap(),
    );
    await this.resetRunningStreamStatuses(waitingStreams);
    this.syncFullView({ forceRebuild: true });
  }

  public isViewVisible(): boolean {
    if (this._activePlacement === 'editor') {
      return this._panelView?.visible === true;
    }
    // Sidebar mode: visible only when MainViewProvider is in progress mode
    return (
      this._mainViewProvider?.getActiveMode() === 'progress' &&
      this._mainViewProvider.getWebviewView()?.visible === true
    );
  }

  private async resetRunningStreamStatuses(
    waitingStreams: Set<StreamTabId>,
  ): Promise<void> {
    const affectedStreams =
      this.eventHandler.resetRunningTasksToError(waitingStreams);

    const streamsWithRunningGroups = await this.state.endRunningTaskGroups(
      Date.now(),
      affectedStreams,
    );

    for (const streamId of streamsWithRunningGroups) {
      if (!affectedStreams.includes(streamId)) {
        this.logger.debug(
          `Stream ${streamId} had running groups but wasn't marked as affected`,
        );
      }
    }
  }

  public async setActiveStream(streamId: StreamTabId): Promise<void> {
    const previous = this.state.activeStream;
    this.state.activeStream = streamId;

    // Catches the "terminal-while-active" case: a stream that reached a
    // non-in-flight status while it was the visible tab never triggered
    // release (the setStreamStatus guard excludes the active stream). Now
    // that the user has moved on, it's eligible.
    if (previous && previous !== streamId) {
      this.state.releasePreviousActive(previous);
    }

    if (!this.canSendToWebview()) return;

    // Rehydrate entries released by the status-change eviction so the
    // newly-active tab shows its full log instead of an empty view.
    if (streamId) await this.state.streamLogs.ensureLoaded(streamId);

    // Another setActiveStream may have run while we awaited rehydration;
    // let the newer call own the webview sync so we don't overwrite it.
    if (this.state.activeStream !== streamId) return;

    this.webviewUpdater.setActiveStream(streamId);
    // Hydrate content (logs, todos, follow-ups, instruction, bypass state) + active-state metadata
    this.eventHandler.syncStreamContent(streamId, { includeActiveState: true });
  }

  public isEditorMode(): boolean {
    return this._activePlacement === 'editor' && this._panelView !== undefined;
  }

  public async showInSidebar(options?: { inPlace?: boolean }): Promise<void> {
    // disposePanelResources resets _activePlacement to 'sidebar' before we
    // get here, so also check the _panelJustDisposed flag to detect a real
    // editor → sidebar transition that needs permission replay.
    const placementChanged =
      this._activePlacement !== 'sidebar' || this._panelJustDisposed;
    this._panelJustDisposed = false;
    this._activePlacement = 'sidebar';

    if (this._mainViewProvider) {
      // Focus first to ensure VS Code resolves the webview before switching content.
      // Without this, switchMode no-ops on first use (view not yet created).
      if (!options?.inPlace) {
        await vscode.commands.executeCommand('texra.mainView.focus');
      }
      await this._mainViewProvider.switchMode('progress');
    } else {
      await setActiveSidebarView(SIDEBAR_VIEWS.PROGRESS);
    }

    if (this.isActivePlacementReady()) {
      this.syncFullView({ forceRebuild: true });
      // Only replay permissions when switching from editor → sidebar.
      // If already on sidebar, the webview already has the correct permissions;
      // replaying would cause duplicates.
      if (placementChanged) this.replayPendingPrompts();
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
      const placementChanged = this._activePlacement !== 'editor';
      this._activePlacement = 'editor';
      await this.restoreSidebarToLauncher();
      this.revealEditorPanel();
      this.syncFullView({ forceRebuild: true });
      if (placementChanged) this.replayPendingPrompts();
      return;
    }

    this._panelView = vscode.window.createWebviewPanel(
      ProgressViewProvider.viewType + '.panel',
      'TeXRA Progress',
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
    await this.restoreSidebarToLauncher();
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

  private async restoreSidebarToLauncher(): Promise<void> {
    if (this._mainViewProvider) {
      await this._mainViewProvider.switchMode('main');
    } else {
      await setActiveSidebarView(SIDEBAR_VIEWS.MAIN);
    }
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
    // Only return the sidebar webview when it's actually showing progress content.
    // Otherwise progress messages would be routed to the launcher webview.
    if (this._mainViewProvider?.getActiveMode() !== 'progress')
      return undefined;
    return this._sidebarWebviewGetter?.();
  }

  private isViewActiveTarget(
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): boolean {
    return this.isPanelView(view)
      ? this._activePlacement === 'editor'
      : this._activePlacement === 'sidebar';
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
      this._panelJustDisposed = true;
    }
    if (disposeView) {
      panelView?.dispose();
    }
  }
}
