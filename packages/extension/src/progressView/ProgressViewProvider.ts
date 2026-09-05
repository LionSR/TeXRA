/**
 * The extension's one conversation shell (PRD one-fold-three-renderers,
 * 7.4, 8, 12.1): the sidebar webview and the editor tab are two ports of
 * the window's session, each folding the same frames to the same view. The
 * provider owns the ports' lifetimes, the `host` snapshot the frames carry,
 * the host request handler, the presentation the runtime asks of a host
 * with no renderer in the loop, and the onboarding funnel the New-task
 * state renders.
 */
import * as path from 'node:path';

import * as vscode from 'vscode';
import { Effect, Fiber, Stream, SubscriptionRef } from 'effect';

import { getAgent, refresh } from '@agent/index';
import type { AgentTrace } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import {
  attachTerminalResultToast,
  defaultSession,
  type SessionHandle,
} from '@agent/runtime';
import { getAuthStatus } from '@commands/auth/authCommands';
import { hasAnyUsableSetupCredential } from '@commands/setup/setupAssistantCommand';
import {
  BundledViewContentProvider,
  getActiveSidebarView,
  getCombinedLocalResourceRoots,
  getSharedLocalResourceRoots,
  setActiveSidebarView,
  SIDEBAR_VIEWS,
} from '@common/webview';
import {
  EXTENSION_CATEGORIES,
  getFilterExtensions,
} from '@common/files/fileTypeUtils';
import { ToolEditApprovalController } from '@controllers/approval/ToolEditApprovalController';
import { planOnboardingFunnelTransition } from '@controllers/onboarding/onboardingFunnel';
import { OnboardingRefreshQueue } from '@controllers/onboarding/OnboardingRefreshQueue';
import {
  ProgressBackend,
  type AttachedPort,
} from '@controllers/progressView/backend/ProgressBackend';
import {
  createHostSnapshotSource,
  type HostSnapshotSource,
} from '@controllers/session/hostSnapshotSource';
import { workspaceFileOptions } from '@controllers/session/workspaceFileOptions';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { VscodeToolEditApprovalHost } from '@frontend/approval/VscodeToolEditApprovalHost';
import {
  isAgentCatalogAuthRefreshDeferred,
  runAfterAgentCatalogAuthRefresh,
} from '@frontend/auth/agentCatalogRefreshScope';
import { createAgentPresentationHost } from '@frontend/events/agentEventListeners';
import { onTexraAuthSessionsChanged } from '@frontend/events/onTexraAuthSessionsChanged';
import { pushManualCriticism } from '@frontend/latex/inlineCriticism';
import { getLinterMessages } from '@frontend/latex/linter';
import { AgentReviewService } from '@frontend/review/AgentReviewService';
import { createLog, isDebugModeEnabled } from '@logger/logUtils';
import { hasUsableSetupCredential } from '@model/setupCredentialAccess';
import { effectRuntime } from '@platform/processRuntime';
import { platform } from '@platform/platform';
import { workspaceRoots } from '@platform/workspaceRoots';
import {
  agentKeyOf,
  AgentCategory,
  type OnboardingFunnelState,
  type StreamTabId,
} from '@shared/schemas';
import { SESSION_DISPOSED_CAUSE } from '@shared/copy/interactionCancellation';
import { paperDisplayOf } from '@shared/session/hostSnapshot';
import type { SurfaceActionMessage } from '@shared/session/sessionFrames';
import {
  readOnboardingFlags,
  setOnboardingDeclined,
} from '@shared/state/onboardingState';
import { debounce } from '@utils/core';
import { DEBOUNCE_OPTIONS_MS } from '@utils/config/constants';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { checkCoreDependencies } from '@utils/system/toolUtils';

import { createExtensionHostRequests } from './extensionHostRequests';

const RECENT_COMMIT_LIMIT = 20;

const log = createLog('ProgressViewProvider');

export type ProgressStreamRevealResult = 'revealed' | 'missing';

/** One transport port: a VS Code webview attached to the backend. */
interface Port {
  readonly attached: AttachedPort;
  readonly disposables: vscode.Disposable[];
}

export class ProgressViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'texra.mainView';
  private static _instance: ProgressViewProvider | undefined;

  public readonly session: SessionHandle;
  public readonly backend: ProgressBackend;
  public readonly snapshot: HostSnapshotSource;
  public readonly toolEditApprovals: ToolEditApprovalController;

  private readonly contentProvider: BundledViewContentProvider;
  private readonly logger: AgentTrace;
  private readonly disposables: vscode.Disposable[] = [];

  /** The sidebar's `WebviewView` while VS Code holds one resolved. */
  private sidebarView: vscode.WebviewView | undefined;
  private sidebarPort: Port | undefined;
  /** The editor tab while popped out. */
  private editorPanel: vscode.WebviewPanel | undefined;
  private editorPort: Port | undefined;

  /** Last computed funnel state, so credential hooks can detect the
   *  in-session State 0 to 1 transition. Session-scoped by design. */
  private onboardingFunnelState: OnboardingFunnelState | undefined;
  /** Funnel refresh derives an edge-triggered transition after awaiting the
   *  credential probe; callers serialize so a later completion cannot
   *  commit a transition from a stale previous state. */
  private readonly onboardingFunnelRefreshQueue = new OnboardingRefreshQueue(
    () => this.refreshOnboardingFunnelSerially(),
  );
  private readonly debouncedRefreshCatalogs = debounce(
    () => void this.refreshCatalogs(),
    DEBOUNCE_OPTIONS_MS,
  );

  constructor(private readonly context: vscode.ExtensionContext) {
    this.logger = createChannelTrace('ProgressViewProvider');
    const session = defaultSession();
    this.session = session;
    this.contentProvider = new BundledViewContentProvider(
      context,
      'ProgressView',
      'progressView',
    );

    const roots = workspaceRoots();
    this.snapshot = createHostSnapshotSource({
      paper: paperDisplayOf(session.roots.storage, roots.workspace),
      placement: 'sidebar',
      globalState: platform().globalState,
      fileOptions: () => workspaceFileOptions(roots.workspace),
      readRecentCommits: async () => {
        const isGitRepo =
          (await vscode.commands.executeCommand<boolean>(
            'texra.isGitRepository',
          )) ?? false;
        const commits = isGitRepo
          ? ((await vscode.commands.executeCommand<string[]>(
              'texra.getRecentCommits',
              RECENT_COMMIT_LIMIT,
            )) ?? [])
          : [];
        return { commits, isGitRepo };
      },
      isAuthenticated: async () => (await getAuthStatus()).authenticated,
      workspaceRoots: () =>
        vscode.workspace.workspaceFolders?.map((folder) => ({
          label: folder.name,
          value: folder.uri.fsPath,
        })) ?? [],
      debugMode: isDebugModeEnabled,
      apiKeyBanner: async () => ({
        visible: !(await hasUsableSetupCredential(
          platform().secrets,
          (message) => log.warn(message),
        )),
      }),
      dependencyBanner: async () => {
        const missingTools = await checkCoreDependencies(false);
        return {
          visible: missingTools.length > 0,
          missingTools: [...missingTools],
        };
      },
      onError: (error) => {
        this.logger.error('Host snapshot refresh failed', { data: error });
      },
    });
    this.disposables.push({
      dispose: this.snapshot.onChange((snapshot) =>
        this.backend.setHost(snapshot),
      ),
    });

    const storageRoot = context.storageUri ?? context.globalStorageUri;
    // The tool-edit preview: staged copies of the original and proposed
    // content the diff editor shows. The request itself is the session's
    // (`approval.requested` folds into the view) and a surface's decision
    // settles it through the `toolEdit` host arm; the staged preview is
    // discarded when the request resolves, whichever way.
    this.toolEditApprovals = new ToolEditApprovalController({
      host: new VscodeToolEditApprovalHost(
        path.join(storageRoot.fsPath, 'tool-edit-previews'),
      ),
      showToolEditPermission: () => undefined,
      resolveToolEditPermission: () => undefined,
      detachCause: SESSION_DISPOSED_CAUSE,
    });
    const resolvedApprovals = effectRuntime().runFork(
      Stream.runForEach(session.events.all(session.now()), (event) =>
        Effect.sync(() => {
          if (event.type !== 'approval.resolved') return;
          this.toolEditApprovals.handleAction({
            requestId: event.requestId,
            action: 'reject',
          });
        }),
      ),
    );
    this.disposables.push({
      dispose: () =>
        effectRuntime().runFork(Fiber.interrupt(resolvedApprovals)),
    });

    const hostRequests = createExtensionHostRequests({
      session,
      sessionKey: session.roots.storage,
      extensionPath: context.extensionPath,
      globalState: context.globalState,
      snapshot: this.snapshot,
      toolEditApprovals: this.toolEditApprovals,
      surfaceAction: (action) => this.surfaceAction(action),
      popOutToEditor: () => this.popOutToEditor(),
      showInSidebar: () => this.showInSidebar(),
      refreshOnboardingFunnel: () => this.refreshOnboardingFunnel(),
    });
    this.disposables.push({ dispose: () => hostRequests.dispose() });
    this.backend = new ProgressBackend({
      session,
      handleHostRequest: (request, port) => hostRequests.handle(request, port),
    });

    // Attached for the window's life: the runtime parks a request until a
    // host is attached, so the presentation must be there before the first
    // run of this window asks anything.
    const detachHostInteractions = session.interactions.use({
      ...createAgentPresentationHost(this),
      readDiagnostics: getLinterMessages,
      addCriticism: (payload) => ({
        accepted: pushManualCriticism(payload),
        resolvedPath: payload.absolutePath,
      }),
      openPdf: async ({ location, preserveFocus }) => {
        await vscode.commands.executeCommand(
          'vscode.open',
          vscode.Uri.file(location.absolutePath),
          {
            viewColumn: vscode.ViewColumn.Beside,
            preserveFocus,
          } satisfies vscode.TextDocumentShowOptions,
        );
      },
      // Findings from the changeReviewer tool-use session flow in through
      // the report_review_issue tool and land in the panel + diagnostics.
      reportReviewIssue: (report) => AgentReviewService.addIssueReport(report),
      requestToolEditApproval: (request) =>
        this.toolEditApprovals.requestApproval(request),
      cancel: (selector) => this.toolEditApprovals.cancel(selector),
    });
    // Terminal-error toasts come from the run's `result` event: this
    // re-emits `requestShow*` through the session's interactions, reaching
    // the presentation dispatch above exactly once.
    const detachTerminalResultToast = attachTerminalResultToast(
      session,
      session.interactions,
      { replayWhenAttached: true },
    );
    this.disposables.push(
      { dispose: detachHostInteractions },
      { dispose: detachTerminalResultToast },
      { dispose: () => this.toolEditApprovals.dispose() },
    );

    this.watchWorkspace();
    ProgressViewProvider._instance = this;
  }

  public static getInstance(): ProgressViewProvider | undefined {
    return this._instance;
  }

  public async initialize(): Promise<void> {
    await this.snapshot.refresh();
    await this.refreshOnboardingFunnel();
    this.logger.debug('ProgressViewProvider initialized');
  }

  // --- The host snapshot's producers ---

  private watchWorkspace(): void {
    // Only a non-first workspace folder can be added or removed here: VS
    // Code restarts the extension host for a first-folder change, so the
    // storage root never moves under a live window (#11432).
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.snapshot.refreshWorkspaceRoots();
        void this.snapshot.refreshFiles();
      }),
    );
    // Watch exactly the categories the launcher file lists are built from
    // (fileListingRules), including user-configured extension overrides, so
    // the watched set cannot drift from what the lists display.
    const extensions = new Set(
      EXTENSION_CATEGORIES.flatMap(getFilterExtensions),
    );
    const filePattern =
      extensions.size === 0 ? '**/*' : `**/*.{${[...extensions].join(',')}}`;
    const fileWatcher = vscode.workspace.createFileSystemWatcher(filePattern);
    const refreshFiles = () => void this.snapshot.refreshFiles();
    fileWatcher.onDidCreate(refreshFiles);
    fileWatcher.onDidDelete(refreshFiles);
    this.disposables.push(
      fileWatcher,
      agentDirectories.watchAgentDirectories(() =>
        this.debouncedRefreshCatalogs(),
      ),
    );
    onTexraAuthSessionsChanged(this.context, () => {
      if (isAgentCatalogAuthRefreshDeferred()) {
        runAfterAgentCatalogAuthRefresh(async () => {
          await Promise.all([
            this.snapshot.refreshCatalogs(),
            this.snapshot.refreshAuth(),
            this.refreshOnboardingFunnel(),
          ]);
        });
        return;
      }
      void this.refreshAfterCredentialChange();
    });
  }

  /** Every credential-dependent surface: catalogs, sign-in, the funnel. */
  public async refreshAfterCredentialChange(): Promise<void> {
    await refresh();
    await Promise.all([
      this.snapshot.refreshCatalogs(),
      this.snapshot.refreshAuth(),
      this.snapshot.refreshHostBanners(),
      this.refreshOnboardingFunnel(),
    ]);
  }

  /** The agent, team, and model catalogs (`texra.refreshAllOptions`). */
  public async refreshCatalogs(
    options: {
      agentCatalogAlreadyFresh?: boolean;
      selectedToolUseAgent?: string;
    } = {},
  ): Promise<void> {
    if (!options.agentCatalogAlreadyFresh) await refresh();
    await this.snapshot.refreshCatalogs();
    if (options.selectedToolUseAgent) {
      this.surfaceAction({
        kind: 'launch',
        patch: { agent: { toolUse: options.selectedToolUseAgent } },
      });
    }
  }

  /** The API-key banner after a key changed in Settings. */
  public refreshHostBanners(): Promise<void> {
    return this.snapshot.refreshHostBanners();
  }

  /** A run loaded an agent from the custom directory. */
  public showAgentConfigBanner(agentName: string): void {
    this.snapshot.setAgentConfigBanner({
      visible: true,
      agentName,
      customDirSet: true,
    });
  }

  /**
   * Single derivation point for the onboarding funnel on this host (PRD:
   * agent-native onboarding): recomputes the user-scoped funnel state into
   * the host snapshot and acts on the State 0 to 1 transition by clearing a
   * stale skip and selecting the setup agent on the launcher. It never
   * auto-starts setup; the user launches it from the setup card.
   */
  public refreshOnboardingFunnel(): Promise<void> {
    return this.onboardingFunnelRefreshQueue.run();
  }

  private async refreshOnboardingFunnelSerially(): Promise<void> {
    // Same usable-credential check the setup command uses. A probe failure
    // still resolves to `false` so the funnel renders something, but not
    // silently: that answer blanks the launcher down to the first-run
    // welcome card for a user who has keys.
    let hasCredential = false;
    try {
      hasCredential = await hasAnyUsableSetupCredential();
    } catch (error) {
      log.warn(
        `Credential probe failed; treating as no credential: ${toErrorMessage(error)}`,
      );
    }
    const transition = planOnboardingFunnelTransition(
      this.onboardingFunnelState,
      { hasCredential, ...readOnboardingFlags(this.context.globalState) },
    );
    this.onboardingFunnelState = transition.state;
    this.snapshot.setOnboarding(transition.state);
    if (transition.clearDeclined) {
      await setOnboardingDeclined(this.context.globalState, false);
    }
    if (transition.selectSetupAgent) {
      // Resolve the qualified registry key so the dropdown matches by value;
      // the plain name still resolves by label if the registry isn't loaded.
      const entry = getAgent('setup', AgentCategory.ToolUse);
      this.surfaceAction({
        kind: 'launch',
        patch: {
          sessionType: 'toolUse',
          agent: { toolUse: entry ? agentKeyOf(entry) : 'setup' },
        },
      });
    }
  }

  // --- Ports ---

  /** The sidebar slot: VS Code resolves it once per document. */
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
      localResourceRoots: getCombinedLocalResourceRoots(this.context, [
        'progressView',
      ]),
    };
    this.closeSidebarPort();
    this.sidebarView = webviewView;
    this.sidebarPort = this.attach('sidebar', webviewView);
    this.sidebarPort.disposables.push(
      webviewView.onDidDispose(() => {
        this.closeSidebarPort();
        this.sidebarView = undefined;
        setActiveSidebarView(SIDEBAR_VIEWS.MAIN);
      }),
    );
  }

  private attach(
    id: 'sidebar' | 'editor',
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): Port {
    view.webview.html = this.contentProvider.getHtmlContent(view.webview, {
      sessionKey: this.backend.key,
    });
    const attached = this.backend.attach({
      id,
      send: (message) => {
        void Promise.resolve(view.webview.postMessage(message)).then(
          (delivered) => {
            if (!delivered) {
              log.warn(`A ${message.kind} message was not delivered to ${id}`);
            }
          },
          (error: unknown) => {
            log.warn(
              `Posting a ${message.kind} message to ${id} failed: ${toErrorMessage(error)}`,
            );
          },
        );
      },
    });
    const disposables: vscode.Disposable[] = [
      view.webview.onDidReceiveMessage((message) => attached.receive(message)),
    ];
    return { attached, disposables };
  }

  private closePort(port: Port | undefined): void {
    if (!port) return;
    for (const disposable of port.disposables) disposable.dispose();
    port.attached.close();
  }

  private closeSidebarPort(): void {
    this.closePort(this.sidebarPort);
    this.sidebarPort = undefined;
  }

  /** The host acting on the surfaces' shared state (PRD 8.5). */
  public surfaceAction(action: SurfaceActionMessage['action']): void {
    this.backend.surfaceAction(action);
  }

  public isViewVisible(): boolean {
    return (
      this.sidebarView?.visible === true || this.editorPanel?.visible === true
    );
  }

  /** Whether the sidebar shows a conversation or the New-task state. */
  public sidebarShowsProgress(): boolean {
    return getActiveSidebarView() === SIDEBAR_VIEWS.PROGRESS;
  }

  public async showInSidebar(): Promise<void> {
    await vscode.commands.executeCommand('texra.mainView.focus');
  }

  /** The New-task state in the sidebar (`texra.showMainView`). */
  public async showLauncher(): Promise<void> {
    await this.showInSidebar();
    this.surfaceAction({ kind: 'selectNew' });
  }

  public async showProgressView(options?: {
    inPlace?: boolean;
  }): Promise<void> {
    if (this.editorPanel) {
      this.editorPanel.reveal(vscode.ViewColumn.One);
      return;
    }
    if (!options?.inPlace) await this.showInSidebar();
  }

  /** Select a stream this window just launched (the launch's
   *  `onStreamResolved` callback): the launching surface selects it. */
  public presentLaunchedStream(streamId: StreamTabId): void {
    this.surfaceAction({ kind: 'select', streamId });
  }

  public async revealStream(
    streamId: StreamTabId,
  ): Promise<ProgressStreamRevealResult> {
    const view = SubscriptionRef.getUnsafe(this.session.view);
    if (!view.streams.has(streamId)) return 'missing';
    await this.showProgressView();
    this.surfaceAction({ kind: 'select', streamId });
    return 'revealed';
  }

  public streamLabel(streamId: StreamTabId): string | undefined {
    return SubscriptionRef.getUnsafe(this.session.view).streams.get(streamId)
      ?.label;
  }

  public async popOutToEditor(): Promise<void> {
    if (this.editorPanel) {
      this.editorPanel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'texra.progress.panel',
      'TeXRA',
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
    this.editorPanel = panel;
    const port = this.attach('editor', panel);
    this.editorPort = port;
    port.disposables.push(
      panel.onDidDispose(() => {
        this.closePort(this.editorPort);
        this.editorPort = undefined;
        this.editorPanel = undefined;
      }),
    );
  }

  public dispose(): void {
    this.closeSidebarPort();
    this.closePort(this.editorPort);
    this.editorPort = undefined;
    this.editorPanel?.dispose();
    this.editorPanel = undefined;
    this.backend.dispose();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    if (ProgressViewProvider._instance === this) {
      ProgressViewProvider._instance = undefined;
    }
  }
}
