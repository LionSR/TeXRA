import * as vscode from 'vscode';

import { getProgressStreamControls } from '@controllers/progressView/progressStreamControls';
import { computeAgentOptionsData } from '@agent/index';
import type { AgentTrace } from '@agent/trace';
import {
  setProgressViewBridge,
  type IProgressViewBridge,
} from '@agent/runtime/ProgressViewBridge';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { detectWaitingStreams } from '@agent/storage/detectWaitingStreams';
import {
  BaseWebviewProvider,
  BundledViewContentProvider,
  getSharedLocalResourceRoots,
  SIDEBAR_VIEWS,
  setActiveSidebarView,
} from '@common/webview';
import { workspaceSM } from '@common/state';
import { bus } from '@eventBus/ProgressEventBus';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { VscodePromptHost } from '@frontend/hosts/VscodePromptHost';
import { createChannelTrace } from '@logger';
import {
  buildVisibleBasicModelOptionsData,
  computeModelOptionsData,
} from '@model/computeModelOptions';
import {
  AgentCategory,
  type AgentProposalPermission,
  type ExternalInquiryPermission,
  type ProgressViewOutboundMessage,
  type ProgressViewPlacement,
  type StreamTabId,
} from '@shared/schemas';
import { agentName } from '@shared/schemas/agent';
import { ProgressBackend } from '@shared/progressView/backend/ProgressBackend';
import {
  buildApprovalRequestHandlerSet,
  createProgressBackendUiConfig,
  type ApprovalRequestHandlerSet,
} from '@shared/progressView/backend/progressBackendUiConfig';
import { repairRestartedStreams } from '@shared/progressView/backend/restartRepair';
import { buildStreamInfo } from '@shared/progressView/backend/streamInfoUtils';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { collectKnownSessionLinks } from '@tools/inquiry/externalInquiryResultFormatter';
import {
  getOpenTurnDraft,
  listThreadsByStatus,
  listOpenThreads,
  manifestToTranscript,
  readExternalInquiryThread,
} from '@tools/inquiry/externalInquiryStorage';

import { ProgressViewMessageHandler } from './ProgressViewMessageHandler';
import { createExtensionHostInteractions } from './extensionHostInteractions';
import { attachProgressBackendProcessBus } from './progressBackendProcessBus';

import type { MainViewProvider } from '../MainViewProvider';

const MAX_INQUIRY_THREAD_HYDRATION = 100;

export type ProgressStreamRevealResult = 'revealed' | 'missing';

/**
 * Orchestrates the progress view webview with exclusive rendering:
 * sidebar OR editor panel, never both as active targets.
 *
 * In sidebar mode, the single `texra.mainView` hosts progress content —
 * MainViewProvider owns the WebviewView and delegates messages here.
 *
 * Implements IProgressViewBridge for agent runtime integration.
 */
export class ProgressViewProvider
  extends BaseWebviewProvider
  implements IProgressViewBridge
{
  public static readonly viewType = 'texra.progress';
  private static _instance: ProgressViewProvider | undefined;

  public readonly backend: ProgressBackend;
  public readonly state: ProgressBackend['state'];
  public readonly eventHandler: ProgressBackend['eventHandler'];
  public readonly webviewBridge: ProgressBackend['webviewBridge'];
  public readonly webviewUpdater: ProgressBackend['webviewUpdater'];

  protected readonly contentProvider: BundledViewContentProvider;
  protected readonly messageHandler: ProgressViewMessageHandler;

  private _sidebarReady = false;
  private _panelReady = false;
  private _panelView?: vscode.WebviewPanel;
  private _panelDisposables: vscode.Disposable[] = [];
  private _activePlacement: ProgressViewPlacement = 'sidebar';
  /** Set by disposePanelResources so showInSidebar knows replay is needed. */
  private _panelJustDisposed = false;
  private _pendingUpdateOptions: { forceRebuild: boolean } | null = null;
  private readonly logger: AgentTrace;

  private _sidebarWebviewGetter?: () => vscode.Webview | undefined;
  private _mainViewProvider?: MainViewProvider;
  private readonly detachHostInteractions: () => void;

  private approvalHandlers!: ApprovalRequestHandlerSet;

  constructor(protected readonly context: vscode.ExtensionContext) {
    super(context);
    this.logger = createChannelTrace('ProgressViewProvider');

    this.backend = new ProgressBackend({
      storage: workspaceSM,
      sendMessage: (message) => this.sendToActiveProgressWebview(message),
      hasTarget: () => this.getActiveWebview() !== undefined,
      getStreamControls: getProgressStreamControls,
      getUnsupportedCommands: () =>
        this.messageHandler.getUnsupportedCommands(),
      configureUi: ({ webviewUpdater: u }) => {
        const canSend = () => this.canSendToWebview();
        this.approvalHandlers = buildApprovalRequestHandlerSet({
          webviewUpdater: u,
          canSend,
          overrides: {
            retry: {
              show: (p) =>
                u.showPermission({ kind: PERMISSION_KIND.RETRY, data: p }),
              resolve: (id) => u.resolvePermission(PERMISSION_KIND.RETRY, id),
            },
            agentProposal: {
              show: (p) => {
                u.showPermission({
                  kind: PERMISSION_KIND.PROPOSAL,
                  data: p,
                  modelOptionsData: buildVisibleBasicModelOptionsData(),
                });
                void this.sendProposalModelOptions(p);
              },
              resolve: (id) =>
                u.resolvePermission(PERMISSION_KIND.PROPOSAL, id),
            },
          },
        });

        // Retry is the one host-specific kind: the extension shows a retry
        // panel via its handler (so the handler also feeds the pending guard).
        return createProgressBackendUiConfig({
          handlers: this.approvalHandlers,
          webviewUpdater: u,
          canSend,
          showRetryRequest: (p) => this.approvalHandlers.retry.show(p),
          resolveRetryRequest: (id) => this.approvalHandlers.retry.resolve(id),
        });
      },
    });
    this.state = this.backend.state;
    this.webviewUpdater = this.backend.webviewUpdater;
    this.webviewBridge = this.backend.webviewBridge;
    this.eventHandler = this.backend.eventHandler;

    this.contentProvider = new BundledViewContentProvider(
      context,
      'ProgressView',
      {
        dist: 'progressView',
        bundleKey: 'progressBundleUri',
        styleKey: 'progressStyleUri',
      },
    );
    this.messageHandler = new ProgressViewMessageHandler(
      this,
      context,
      new VscodePromptHost(),
      defaultSession().coordinators,
      defaultSession().interactions,
    );
    this.detachHostInteractions = defaultSession().useHostInteractions(
      createExtensionHostInteractions({
        runtimeHost: extensionAgentRuntimeHost,
        getApprovalHandlers: () => this.approvalHandlers,
      }),
    );
    this._disposables.push({ dispose: this.detachHostInteractions });

    ProgressViewProvider._instance = this;
    setProgressViewBridge(this);

    this._disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        await this.backend.load();
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
    await this.backend.load();
    this._disposables.push(
      this.backend.setupEventListeners(),
      attachProgressBackendProcessBus(this.backend, bus),
    );
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

  public async refreshOnboardingFunnel(): Promise<void> {
    await this._mainViewProvider?.refreshOnboardingFunnel();
  }

  public getContentProvider(): BundledViewContentProvider {
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
   * removed from the agent-proposal handler. We check before sending so the
   * late SHOW doesn't re-create an undismissable ghost proposal.
   *
   * Uses a 30-second TTL cache to avoid redundant async work when
   * multiple proposals arrive in quick succession.
   */
  private async sendProposalModelOptions(
    proposal: AgentProposalPermission,
  ): Promise<void> {
    // Model options have a visible-model fallback that does not require
    // ServerSideKeyService, so the dropdown still appears if availability
    // loading fails. Agent options have no static equivalent, so the agent
    // dropdown is omitted when the registry fetch fails.
    const isWorkflow = proposal.agentCategory === AgentCategory.Workflow;
    const loadAgentOptions = async () => {
      const all = await computeAgentOptionsData();
      const raw = isWorkflow ? all.workflow : all.toolUse;
      // proposal.agent is a plain name, so keep identity separate from label.
      return raw.map((opt) => ({ ...opt, value: agentName(opt.value) }));
    };
    const [modelOptions, agentOptions] = await Promise.all([
      computeModelOptionsData(undefined, undefined, {
        agentCategory: proposal.agentCategory,
      }).catch(() => buildVisibleBasicModelOptionsData()),
      loadAgentOptions().catch(() => undefined),
    ]);
    if (!this.approvalHandlers.agentProposal.get(proposal.proposalId)) return;
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
      this.eventHandler.getAllStreamStates(),
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
    if (this.approvalHandlers.externalInquiry.pendingSize > 0) return;

    const open = await listOpenThreads().catch((error) => {
      // A storage read failure here silently skips inquiry hydration; log
      // it so the missing panel reappearance is diagnosable.
      this.logger.debug(`Failed to list open inquiry threads: ${error}`);
      return undefined;
    });
    if (!open) return;

    for (const summary of open) {
      try {
        const manifest = await readExternalInquiryThread(summary.threadId);
        if (!manifest || manifest.status !== 'open') continue;
        if (!manifest.parentStreamId) continue;
        const lastTurn = manifest.turns.at(-1);
        if (!lastTurn || lastTurn.kind !== 'open') continue;
        const isFollowUp = manifest.turns.length > 1;
        const sessionLinks = collectKnownSessionLinks(manifest);
        const draft = getOpenTurnDraft(manifest);
        const transcript = manifestToTranscript(manifest);
        const hydrationFields = {
          sessionLinks,
          draft,
          transcript,
        };
        const basePermission = {
          requestId: manifest.threadId,
          threadId: manifest.threadId,
          question: lastTurn.question,
          context: lastTurn.context ?? undefined,
          suggestSearch: lastTurn.suggestSearch ?? undefined,
          attachFiles: lastTurn.attachFiles ?? undefined,
          allowBypass: false,
          streamId: manifest.parentStreamId,
        };
        const permission: ExternalInquiryPermission = isFollowUp
          ? {
              ...basePermission,
              ...hydrationFields,
              mode: 'followUp',
            }
          : {
              ...basePermission,
              ...hydrationFields,
              mode: 'new',
            };
        this.approvalHandlers.externalInquiry.show(permission);
      } catch {
        // Skip threads whose manifest can't be read; surface logs elsewhere.
      }
    }
  }

  private replayPendingPrompts(): void {
    if (!this.webviewUpdater.isAvailable()) {
      return;
    }

    this.approvalHandlers.toolEdit.replay();
    this.approvalHandlers.bash.replay();
    this.approvalHandlers.externalInquiry.replay();
    // YOLO / Super YOLO state is already sent by syncFullView() which is
    // always called before replayPendingPrompts() in markWebviewReady().

    this.approvalHandlers.retry.replay();
    this.approvalHandlers.agentProposal.replay();
    this.approvalHandlers.planApproval.replay();
  }

  public getPendingAgentProposal(
    proposalId: string,
  ): AgentProposalPermission | undefined {
    return this.approvalHandlers.agentProposal.get(proposalId);
  }

  private canSendToWebview(): boolean {
    return this.isActivePlacementReady() && this.webviewUpdater.isAvailable();
  }

  public async cleanupTasksAfterRestart(): Promise<void> {
    const executionIds = this.state.snapshots.getExecutionIdMap();
    const waitingStreams = await detectWaitingStreams(executionIds);
    await repairRestartedStreams({
      streamStatus: this.state.streamStatus,
      waitingStreams,
      executionIds,
      repairStreams: executionIds.keys(),
      closeRunningGroups: (streamIds, status, now) =>
        this.state.endRunningTaskGroups(now, streamIds, status),
      statusEmitOptions: { trace: this.logger },
      logger: this.logger,
    });
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

  public async revealStream(
    streamId: StreamTabId,
  ): Promise<ProgressStreamRevealResult> {
    if (!this.state.streamLogs.has(streamId)) return 'missing';

    await this.showProgressView();

    // Clear filters owned by the progress view before selecting the stream;
    // otherwise SET_ACTIVE_STREAM can target a stream hidden by the current
    // category filter and appear to do nothing.
    if (
      buildStreamInfo(this.state, streamId, this.state.agentCategoryFilter) ===
      null
    ) {
      this.state.agentCategoryFilter = 'all';
      this.syncFullView();
    }

    await this.setActiveStream(streamId);
    return 'revealed';
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
    this._panelView.iconPath = new vscode.ThemeIcon('pulse');
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
    this.backend.dispose();
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

  private async sendToActiveProgressWebview(
    message: ProgressViewOutboundMessage,
  ): Promise<boolean> {
    const webview = this.getActiveWebview();
    if (!webview) return false;
    try {
      return await webview.postMessage(message);
    } catch {
      return false;
    }
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
