import * as path from 'node:path';

import * as vscode from 'vscode';

import type { AgentTrace } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import { attachTerminalResultToast, defaultSession } from '@agent/runtime';
import {
  BaseWebviewProvider,
  BundledViewContentProvider,
  getActiveSidebarView,
  getSharedLocalResourceRoots,
  SIDEBAR_VIEWS,
} from '@common/webview';
import { ToolEditApprovalController } from '@controllers/approval/ToolEditApprovalController';
import { replayApprovalRequestHandlers } from '@controllers/progressView/backend/progressBackendUiConfig';
import { ProgressBackend } from '@controllers/progressView/backend/ProgressBackend';
import { getProgressStreamControls } from '@controllers/progressView/progressStreamControls';

import { VscodeToolEditApprovalHost } from '@frontend/approval/VscodeToolEditApprovalHost';
import { VscodePromptHost } from '@frontend/hosts/VscodePromptHost';
import { createAgentPresentationHost } from '@frontend/events/agentEventListeners';
import { DisposableStore } from '@platform/disposable';
import { platform } from '@platform/platform';
import type { AgentProposalPermission, StreamTabId } from '@shared/schemas';
import {
  formatActiveStreamRetention,
  formatStreamDeletionRetention,
} from '@shared/copy/executionHistory';
import { SESSION_DISPOSED_CAUSE } from '@shared/copy/interactionCancellation';
import { ProgressViewMessageHandler } from './ProgressViewMessageHandler';
import { createExtensionHostInteractions } from './extensionHostInteractions';

import type { MainViewProvider } from '../webview/MainViewProvider';

export type ProgressStreamRevealResult = 'revealed' | 'missing';

/**
 * The one surface progress content is rendered into.
 *
 * `ready` is that surface's own webview-ready handshake, and the editor
 * variant owns the panel plus the listeners that live and die with it — so
 * "the panel exists" and "the editor is the target" are the same fact rather
 * than two fields to keep in step, and a readiness flag can never outlive the
 * surface it described. `undefined` is the honest gap after a panel teardown
 * and before the next placement claim: no surface is showing progress.
 */
type ProgressTarget =
  | { readonly placement: 'sidebar'; ready: boolean }
  | {
      readonly placement: 'editor';
      readonly panel: vscode.WebviewPanel;
      readonly disposables: DisposableStore;
      ready: boolean;
    };

/**
 * Orchestrates the progress view webview with exclusive rendering:
 * sidebar OR editor panel, never both as active targets.
 *
 * In sidebar mode, the single `texra.mainView` hosts progress content —
 * MainViewProvider owns the WebviewView and delegates messages here.
 *
 */
export class ProgressViewProvider extends BaseWebviewProvider {
  public static readonly viewType = 'texra.progress';
  private static _instance: ProgressViewProvider | undefined;

  /** Packaged extension root, for host-bundled assets such as the trace viewer. */
  get extensionPath(): string {
    return this.context.extensionPath;
  }

  public readonly backend: ProgressBackend;
  public readonly toolEditApprovals: ToolEditApprovalController;
  public readonly state: ProgressBackend['state'];
  public readonly renderer: ProgressBackend['renderer'];

  protected readonly contentProvider: BundledViewContentProvider;
  protected readonly messageHandler: ProgressViewMessageHandler;

  /** Sole owner of "which surface currently shows progress content". */
  private target: ProgressTarget | undefined = {
    placement: 'sidebar',
    ready: false,
  };
  /** Current progress document identity for each reusable VS Code webview. */
  private readonly documentIdentities = new WeakMap<vscode.Webview, object>();
  private readonly logger: AgentTrace;

  private _mainViewProvider?: MainViewProvider;
  private readonly detachHostInteractions: () => void;

  constructor(protected override readonly context: vscode.ExtensionContext) {
    super(context);
    this.logger = createChannelTrace('ProgressViewProvider');

    const runtimeSession = defaultSession();
    this.backend = new ProgressBackend({
      session: runtimeSession,
      storage: platform().workspaceState,
      sendMessage: async (message) => {
        const webview = this.getActiveWebview();
        if (!webview) return false;
        // Delivery failures belong to WebviewBridge's retry path or the
        // backend's best-effort refresh path, so let postMessage reject.
        return webview.postMessage(message);
      },
      hasTarget: () => this.getActiveWebview() !== undefined,
      getStreamControls: getProgressStreamControls,
      getUnsupportedCommands: () =>
        this.messageHandler.getUnsupportedCommands(),
      reportTranscriptLoadError: (error, stream) =>
        this.reportTranscriptLoadError(error, stream),
      approvals: {
        canSend: () =>
          this.target?.ready === true && this.renderer.isAvailable(),
        logger: this.logger,
      },
      lifecycle: {
        stopStream: (stream, options) =>
          this.messageHandler.stopStream(stream, options),
        cleanupDeletedStream: (stream) =>
          this.messageHandler.cleanupDeletedStream(stream),
        cleanupDeletedStreams: (options) =>
          this.messageHandler.cleanupDeletedStreams(options),
        rebuildRenderedStreams: (options) => this.syncRenderedStreams(options),
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
    this.renderer = this.backend.renderer;

    this.contentProvider = new BundledViewContentProvider(
      context,
      'ProgressView',
      'progressView',
    );
    const presentationHost = createAgentPresentationHost(this);
    const storageRoot = context.storageUri ?? context.globalStorageUri;
    this.toolEditApprovals = new ToolEditApprovalController({
      interactions: presentationHost,
      session: runtimeSession,
      host: new VscodeToolEditApprovalHost(
        path.join(storageRoot.fsPath, 'tool-edit-previews'),
      ),
      showToolEditPermission: (payload) =>
        this.backend.approvalHandlers.toolEdit.show(payload),
      resolveToolEditPermission: (requestId) =>
        this.backend.approvalHandlers.toolEdit.dismiss(requestId),
      detachCause: SESSION_DISPOSED_CAUSE,
    });
    const interactions = createExtensionHostInteractions({
      interactions: presentationHost,
      session: runtimeSession,
      getApprovalHandlers: () => this.backend.approvalHandlers,
      getToolEditApprovals: () => this.toolEditApprovals,
      setApprovalBypassState: this.backend.setApprovalBypassState,
    });
    this.messageHandler = new ProgressViewMessageHandler(
      this,
      new VscodePromptHost(),
      interactions,
    );
    this.backend.setupEventListeners();
    this.detachHostInteractions = runtimeSession.interactions.use(interactions);
    // Terminal-error toasts come from the run's `result` event (the lifecycle
    // no longer emits them directly). This re-emits `requestShow*` through
    // the session's interactions, reaching the presentation dispatch above
    // exactly once, whichever host is currently attached.
    const detachTerminalResultToast = attachTerminalResultToast(
      runtimeSession,
      runtimeSession.interactions,
      { replayWhenAttached: true },
    );
    this._disposables.add({ dispose: this.detachHostInteractions });
    this._disposables.add({
      dispose: () => this.toolEditApprovals.dispose(),
    });
    this._disposables.add({ dispose: detachTerminalResultToast });

    ProgressViewProvider._instance = this;

    this._disposables.add(
      // Only a non-first workspace folder can be added or removed here: VS
      // Code restarts the extension host for a first-folder change, so the
      // storage root never moves under a live window. Nothing to reload but
      // the view (#11432).
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.syncFullView()),
    );
  }

  public async initialize(): Promise<void> {
    await this.backend.load();
    this.logger.debug('ProgressViewProvider initialized');
  }

  // --- Wiring from extension.ts ---

  public setMainViewProvider(mvp: MainViewProvider): void {
    this._mainViewProvider = mvp;
  }

  public async refreshOnboardingFunnel(): Promise<void> {
    await this._mainViewProvider?.refreshOnboardingFunnel();
  }

  public override setupWebviewContent(
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): vscode.Disposable {
    this.documentIdentities.set(view.webview, {});
    return super.setupWebviewContent(view);
  }

  /** Capture whether this exact progress document still occupies its webview. */
  public captureWebviewDocument(webview: vscode.Webview): () => boolean {
    const identity = this.documentIdentities.get(webview);
    return () =>
      identity !== undefined &&
      this.documentIdentities.get(webview) === identity;
  }

  /** Invalidate a progress document before its webview is reused or disposed. */
  public invalidateWebviewDocument(webview: vscode.Webview): void {
    this.documentIdentities.delete(webview);
  }

  /** The sidebar stopped showing progress content; its handshake is void. */
  public resetSidebarReady(): void {
    if (this.target?.placement === 'sidebar') this.target.ready = false;
  }

  public static getInstance(): ProgressViewProvider | undefined {
    return this._instance;
  }

  public syncFullView(): void {
    void this.syncRenderedStreams({ syncActiveStream: true });
  }

  /**
   * Resend stream metadata, and the active stream's content when asked for.
   * A metadata-only refresh is what the backend requests after a deletion that
   * left the active stream untouched.
   */
  private syncRenderedStreams({
    syncActiveStream,
  }: {
    syncActiveStream: boolean;
  }): Promise<void> {
    const target = this.target;
    if (!target?.ready) return Promise.resolve();

    if (!this.getActiveWebview()) return Promise.resolve();

    this.renderer.setPlacement(target.placement);

    return this.backend.syncRenderedStreams({ syncActiveStream });
  }

  public async markWebviewReady(
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    const target = this.target;
    // A handshake from a surface that no longer holds the target describes
    // content that has since been swapped away; it has nothing to sync.
    if (!target) return;
    const isEditorView = 'viewColumn' in view;
    if ((target.placement === 'editor') !== isEditorView) return;

    target.ready = true;
    this.syncFullView();
    if (!this.renderer.isAvailable()) return;

    await replayApprovalRequestHandlers(this.backend.approvalHandlers);
    // YOLO / Super YOLO state is already sent by syncFullView() before replay.
  }

  public getPendingAgentProposal(
    requestId: string,
  ): AgentProposalPermission | undefined {
    return this.backend.approvalHandlers.proposal.get(requestId);
  }

  public isViewVisible(): boolean {
    const target = this.target;
    if (!target) return false;
    if (target.placement === 'editor') return target.panel.visible;
    // Sidebar mode: visible only while the sidebar shows progress content
    return (
      getActiveSidebarView() === SIDEBAR_VIEWS.PROGRESS &&
      this._mainViewProvider?.getWebviewView()?.visible === true
    );
  }

  public setActiveStream(
    streamId: StreamTabId | '',
    requestId?: string,
  ): Promise<void> {
    return this.backend.activateStream(streamId, requestId);
  }

  private reportTranscriptLoadError(
    error: unknown,
    streamId?: StreamTabId | '',
  ): void {
    this.logger.error(
      `Failed to load transcript for display${streamId ? ` ${streamId}` : ''}`,
      { data: error },
    );
    void vscode.window.showErrorMessage(
      'TeXRA could not read this transcript. Select the run again to retry.',
    );
  }

  public async revealStream(
    streamId: StreamTabId,
  ): Promise<ProgressStreamRevealResult> {
    if (!this.state.streamLogs.has(streamId)) return 'missing';

    await this.showProgressView();
    await this.setActiveStream(streamId);
    return 'revealed';
  }

  public async showInSidebar(options?: { inPlace?: boolean }): Promise<void> {
    // Claiming the sidebar releases the editor panel: one surface owns
    // progress content at a time, so the panel cannot outlive its target.
    this.releaseEditorTarget({ disposePanel: true });
    this.target ??= { placement: 'sidebar', ready: false };

    // Focus first to ensure VS Code resolves the webview before switching content.
    // Without this, switchMode no-ops on first use (view not yet created).
    if (!options?.inPlace) {
      await vscode.commands.executeCommand('texra.mainView.focus');
    }
    this._mainViewProvider?.switchMode(SIDEBAR_VIEWS.PROGRESS);

    // A ready sidebar target means `switchMode` found the view already showing
    // progress and returned early, so no ready handshake follows to refresh it.
    // A target created just above is not ready, and its handshake replays
    // pending prompts itself (`markWebviewReady`).
    if (this.target?.ready === true) {
      this.syncFullView();
    }
  }

  public async showProgressView(options?: {
    inPlace?: boolean;
  }): Promise<void> {
    const target = this.target;
    if (target?.placement === 'editor') {
      target.panel.reveal(vscode.ViewColumn.One);
      if (target.ready) this.syncFullView();
      return;
    }
    await this.showInSidebar(options);
  }

  public async popOutToEditor(): Promise<void> {
    const target = this.target;
    if (target?.placement === 'editor') {
      this._mainViewProvider?.switchMode(SIDEBAR_VIEWS.MAIN);
      target.panel.reveal(vscode.ViewColumn.One);
      this.syncFullView();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
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
    panel.iconPath = new vscode.ThemeIcon('pulse');
    const disposables = new DisposableStore();
    // Claim the target before wiring content: the webview's ready handshake
    // can only arrive after this synchronous block, and it needs the panel to
    // already be the target it reports readiness for.
    this.target = { placement: 'editor', panel, disposables, ready: false };

    disposables.add(this.setupWebviewContent(panel));
    disposables.add(
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) {
          this.syncFullView();
        }
      }),
    );
    disposables.add(
      panel.onDidDispose(() => {
        this.releaseEditorTarget();
      }),
    );

    this._mainViewProvider?.switchMode(SIDEBAR_VIEWS.MAIN);
  }

  public override dispose(): void {
    this.releaseEditorTarget({ disposePanel: true });
    this.backend.dispose();
    super.dispose();
  }

  /**
   * Give up the editor target, leaving no surface until the next claim.
   * Re-entrant by construction: the target is dropped before the panel is
   * disposed, so the `onDidDispose` callback finds nothing left to release.
   */
  private releaseEditorTarget(options: { disposePanel?: boolean } = {}): void {
    const target = this.target;
    if (target?.placement !== 'editor') return;
    this.invalidateWebviewDocument(target.panel.webview);
    this.target = undefined;
    try {
      target.disposables.dispose();
    } finally {
      if (options.disposePanel) target.panel.dispose();
    }
  }

  private getActiveWebview(): vscode.Webview | undefined {
    const target = this.target;
    if (!target) return undefined;
    if (target.placement === 'editor') return target.panel.webview;
    // Only return the sidebar webview when it's actually showing progress content.
    // Otherwise progress messages would be routed to the launcher webview.
    if (getActiveSidebarView() !== SIDEBAR_VIEWS.PROGRESS) return undefined;
    return this._mainViewProvider?.getWebviewView()?.webview;
  }
}
