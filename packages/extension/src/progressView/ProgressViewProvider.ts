import * as vscode from 'vscode';

import { getProgressStreamControls } from '@controllers/progressView/progressStreamControls';
import { ProgressBackend } from '@controllers/progressView/backend/ProgressBackend';
import { replayApprovalRequestHandlers } from '@controllers/progressView/backend/progressBackendUiConfig';
import {
  repairRestartedStreams,
  RestartRepairRetryScheduler,
} from '@controllers/progressView/backend/restartRepair';
import { buildStreamInfo } from '@controllers/progressView/backend/streamInfoUtils';
import { computeAgentOptionsData } from '@agent/index';
import type { AgentTrace } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
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
import { appSignals } from '@eventBus/AppSignals';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { setExtensionInteractionEventSink } from '@frontend/events/extensionInteractionEvents';
import { VscodePromptHost } from '@frontend/hosts/VscodePromptHost';
import {
  buildVisibleBasicModelOptionsData,
  computeModelOptionsData,
} from '@model/computeModelOptions';
import {
  AgentCategory,
  type AgentProposalPermission,
  type ProgressViewOutboundMessage,
  type ProgressViewPlacement,
  type StreamTabId,
} from '@shared/schemas';
import { agentName } from '@shared/schemas/agent';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import {
  formatActiveStreamRetention,
  formatStreamDeletionRetention,
} from '@shared/copy/executionHistory';

import { ProgressViewMessageHandler } from './ProgressViewMessageHandler';
import { createExtensionHostInteractions } from './extensionHostInteractions';
import { attachProgressBackendAppSignals } from './progressBackendAppSignals';
import type { ProgressBackendInteractionPayloads } from '@controllers/progressView/backend/events/ProgressInteractionHandler';

import type { MainViewProvider } from '../MainViewProvider';

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
  public readonly interactionHandler: ProgressBackend['interactionHandler'];
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
  private readonly restartRepairRetry = new RestartRepairRetryScheduler();

  private _sidebarWebviewGetter?: () => vscode.Webview | undefined;
  private _mainViewProvider?: MainViewProvider;
  private readonly detachHostInteractions: () => void;

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
      approvals: {
        canSend: () => this.canSendToWebview(),
        logger: this.logger,
        overrides: {
          retry: {
            show: (p) =>
              this.webviewUpdater.showPermission({
                kind: PERMISSION_KIND.RETRY,
                data: p,
              }),
            dismiss: (id) =>
              this.webviewUpdater.resolvePermission(PERMISSION_KIND.RETRY, id),
          },
          agentProposal: {
            show: (p) => {
              this.webviewUpdater.showPermission({
                kind: PERMISSION_KIND.PROPOSAL,
                data: p,
                modelOptionsData: buildVisibleBasicModelOptionsData(),
              });
              void this.sendProposalModelOptions(p);
            },
            dismiss: (id) =>
              this.webviewUpdater.resolvePermission(
                PERMISSION_KIND.PROPOSAL,
                id,
              ),
          },
        },
      },
      lifecycle: {
        stopStream: (stream, _ownerSession, options) =>
          this.messageHandler.stopStream(stream, options),
        cleanupDeletedStream: (stream) =>
          this.messageHandler.cleanupDeletedStream(stream),
        cleanupDeletedStreams: (options) =>
          this.messageHandler.cleanupDeletedStreams(options),
        rebuildRenderedStreams: (options) => this.syncFullView(options),
        activateStream: (stream) => this.setActiveStream(stream),
        notifyDeletionRetained: async (activeCount, failedCount) => {
          await vscode.window.showInformationMessage(
            failedCount === 0
              ? formatActiveStreamRetention(activeCount)
              : formatStreamDeletionRetention(activeCount, failedCount),
          );
        },
      },
    });
    this.state = this.backend.state;
    this.webviewUpdater = this.backend.webviewUpdater;
    this.webviewBridge = this.backend.webviewBridge;
    this.interactionHandler = this.backend.interactionHandler;

    this.contentProvider = new BundledViewContentProvider(
      context,
      'ProgressView',
      {
        dist: 'progressView',
        bundleKey: 'progressBundleUri',
        styleKey: 'progressStyleUri',
      },
    );
    const interactions = createExtensionHostInteractions({
      runtimeHost: extensionAgentRuntimeHost,
      session: defaultSession(),
      getApprovalHandlers: () => this.backend.approvalHandlers,
    });
    this.messageHandler = new ProgressViewMessageHandler(
      this,
      new VscodePromptHost(),
      interactions,
    );
    const progressBackendSubscription = this.backend.setupEventListeners();
    this.detachHostInteractions =
      defaultSession().useHostInteractions(interactions);
    const detachExtensionInteractionEvents = setExtensionInteractionEventSink(
      (event, payload) => {
        this.backend.handleInteractionEvent(
          event,
          payload as ProgressBackendInteractionPayloads[typeof event],
        );
      },
    );
    this._disposables.push(
      progressBackendSubscription,
      { dispose: this.detachHostInteractions },
      { dispose: detachExtensionInteractionEvents },
    );

    ProgressViewProvider._instance = this;
    setProgressViewBridge(this);

    this._disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        try {
          await this.backend.load();
          this.syncFullView({ forceRebuild: true });
        } catch (error) {
          this.logger.error(
            'Failed to reload transcripts after workspace change',
            {
              data: error,
            },
          );
          void vscode.window.showErrorMessage(
            'TeXRA could not reload transcript persistence for the new workspace. The previous transcript view was preserved.',
          );
        }
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
      attachProgressBackendAppSignals(this.backend, appSignals),
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
    if (!this.backend.approvalHandlers.agentProposal.get(proposal.proposalId))
      return;
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
      this.backend.factApplier.getAllStreamStates(),
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
        void this.state.streamLogs
          .ensureLoaded(activeStream)
          .then(() => {
            if (this.state.activeStream !== activeStream) return;
            this.backend.factApplier.syncStreamContent(activeStream);
          })
          .catch((error: unknown) => {
            this.logger.error(
              `Failed to load transcript ${activeStream} for display`,
              { data: error },
            );
            void vscode.window.showErrorMessage(
              'TeXRA could not read this persisted transcript.',
            );
          });
      } else {
        this.backend.factApplier.syncStreamContent(activeStream);
      }
    }

    this._pendingUpdateOptions = null;
  }

  public async markWebviewReady(
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
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
    await this.replayPendingPrompts();
  }

  private async replayPendingPrompts(): Promise<void> {
    if (!this.webviewUpdater.isAvailable()) return;

    await replayApprovalRequestHandlers(this.backend.approvalHandlers);
    // YOLO / Super YOLO state is already sent by syncFullView() before replay.
  }

  public getPendingAgentProposal(
    proposalId: string,
  ): AgentProposalPermission | undefined {
    return this.backend.approvalHandlers.agentProposal.get(proposalId);
  }

  private canSendToWebview(): boolean {
    return this.isActivePlacementReady() && this.webviewUpdater.isAvailable();
  }

  public async cleanupTasksAfterRestart(): Promise<void> {
    const executionIds = this.state.snapshots.getExecutionIdMap();
    const waitingStreams = await detectWaitingStreams(executionIds);
    const repairStreams = new Set<StreamTabId>([
      ...executionIds.keys(),
      ...this.state.streamLogs.keys(),
    ]);
    const result = await repairRestartedStreams({
      streamStatus: this.state.streamStatus,
      waitingStreams,
      executionIds,
      repairStreams,
      closeRunningGroups: (streamIds, status, now) =>
        this.state.endRunningTaskGroups(now, streamIds, status),
      statusEmitOptions: { trace: this.logger },
      logger: this.logger,
    });
    this.restartRepairRetry.schedule(result.nextLeaseCheckAt, () => {
      void this.cleanupTasksAfterRestart().catch((error: unknown) => {
        this.logger.warn('Failed delayed restart repair', { data: error });
      });
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
    this.backend.factApplier.syncStreamContent(streamId, {
      includeActiveState: true,
    });
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
      if (placementChanged) await this.replayPendingPrompts();
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
      if (placementChanged) await this.replayPendingPrompts();
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
    this.restartRepairRetry.dispose();
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
