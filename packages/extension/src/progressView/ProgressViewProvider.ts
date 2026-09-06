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
import { HostDraftRequests } from '@controllers/session/hostDraftRequests';
import { planOnboardingFunnelTransition } from '@controllers/onboarding/onboardingFunnel';
import { OnboardingRefreshQueue } from '@controllers/onboarding/OnboardingRefreshQueue';
import {
  SessionBridge,
  type AttachedPort,
} from '@controllers/session/SessionBridge';
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
  type SessionType,
  type StreamTabId,
} from '@shared/schemas';
import { paperDisplayOf } from '@shared/session/hostSnapshot';
import type {
  DownMessage,
  SurfaceActionMessage,
} from '@shared/session/sessionFrames';
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

/** One transport port: a VS Code webview attached to the bridge. */
interface Port {
  readonly attached: AttachedPort;
  readonly disposables: vscode.Disposable[];
  /** A frame for this port alone (the chime, the accelerator, the drawer). */
  readonly send: (message: DownMessage) => void;
}

export class ProgressViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'texra.mainView';
  private static _instance: ProgressViewProvider | undefined;

  public readonly session: SessionHandle;
  public readonly bridge: SessionBridge;
  public readonly snapshot: HostSnapshotSource;
  public readonly toolEditApprovals: ToolEditApprovalController;

  private readonly contentProvider: BundledViewContentProvider;
  private readonly logger: AgentTrace;
  private readonly disposables: vscode.Disposable[] = [];

  /** The sidebar's `WebviewView` while VS Code holds one resolved. */
  private sidebarView: vscode.WebviewView | undefined;
  private sidebarPort: Port | undefined;
  /** The popped-out tab and its port, attached and released together. */
  private editor: { panel: vscode.WebviewPanel; port: Port } | undefined;

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
      session,
    });
    // A workflow run's `result` is the completion chime, one per process
    // (PRD 12.4), never a renderer transition hook that every subscriber
    // would replay. A failed run does not chime.
    const sessionEvents = effectRuntime().runFork(
      Stream.runForEach(session.events.all(session.now()), (event) =>
        Effect.sync(() => {
          if (
            event.type === 'result' &&
            event.category === 'workflow' &&
            event.outcome !== 'failed'
          ) {
            this.chime();
          }
        }),
      ),
    );
    this.disposables.push({
      dispose: () => {
        effectRuntime().runFork(Fiber.interrupt(sessionEvents));
      },
    });

    const hostRequests = createExtensionHostRequests({
      session,
      extensionPath: context.extensionPath,
      globalState: context.globalState,
      snapshot: this.snapshot,
      draftRequests: new HostDraftRequests(),
      toolEditApprovals: this.toolEditApprovals,
      surfaceAction: (action) => this.surfaceAction(action),
      popOutToEditor: () => this.popOutToEditor(),
      showInSidebar: () => this.showInSidebar(),
      refreshOnboardingFunnel: () => this.refreshOnboardingFunnel(),
    });
    this.disposables.push({ dispose: () => hostRequests.dispose() });
    this.bridge = new SessionBridge({
      session,
      handleHostRequest: (request, port) => hostRequests.handle(request, port),
      onPortClosed: hostRequests.closePort,
    });
    // After the bridge: creating the host requests already published a
    // snapshot (the recorder's first observation), and `initialize` refreshes
    // the full one once the provider stands.
    this.disposables.push({
      dispose: this.snapshot.onChange((snapshot) =>
        this.bridge.setHost(snapshot),
      ),
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
  public showAgentConfigBanner(
    agentName: string,
    sessionType: SessionType,
  ): void {
    this.snapshot.showAgentConfigBanner(agentName, sessionType);
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
      sessionKey: this.bridge.key,
      placement: id,
    });
    const send = (message: DownMessage): void => {
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
    };
    const attached = this.bridge.attach({ id, send });
    const disposables: vscode.Disposable[] = [
      view.webview.onDidReceiveMessage((message) => attached.receive(message)),
    ];
    return { attached, disposables, send };
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
    this.bridge.surfaceAction(action);
  }

  private frameOf(
    action: SurfaceActionMessage['action'],
  ): SurfaceActionMessage {
    return { kind: 'surface.action', session: this.bridge.key, action };
  }

  /**
   * The one rule for which surface a host action lands on: the one the user
   * is looking at, the editor tab first while it is the active panel, then a
   * visible sidebar, then a visible tab. Attachment is not visibility here:
   * the sidebar keeps its port and its own webview state while hidden
   * (`retainContextWhenHidden`), so a hidden sidebar must not outrank the
   * tab on screen. `undefined` when no surface is showing.
   */
  private visibleSurfacePort(): Port | undefined {
    const editor = this.editor;
    if (editor?.panel.active === true) return editor.port;
    if (this.sidebarView?.visible === true) return this.sidebarPort;
    if (editor?.panel.visible === true) return editor.port;
    return undefined;
  }

  /** The completion chime plays once per process, in the surface the user is
   *  looking at. With none showing it still plays in a retained sidebar (or
   *  a hidden tab), which is the case a chime is for: a run the user walked
   *  away from. No port means no renderer to play it. */
  private chime(): void {
    const port =
      this.visibleSurfacePort() ?? this.sidebarPort ?? this.editor?.port;
    port?.send(this.frameOf({ kind: 'chime' }));
  }

  /** `texra.execute` with no configuration (Cmd+Alt+E): the composer's
   *  Send in the view the user is in, which is the visible surface and its
   *  own draft. With none showing, the sidebar, shown first so the action
   *  has a surface to land on. */
  public async submit(): Promise<void> {
    const port = this.visibleSurfacePort();
    if (port !== undefined && port === this.editor?.port) {
      port.send(this.frameOf({ kind: 'submit' }));
      return;
    }
    await this.showInSidebar();
    this.sidebarPort?.send(this.frameOf({ kind: 'submit' }));
  }

  /** `texra.toggleView`: the Sessions drawer of the sidebar. */
  public async toggleDrawer(): Promise<void> {
    await this.showInSidebar();
    this.sidebarPort?.send(this.frameOf({ kind: 'toggleDrawer' }));
  }

  public isViewVisible(): boolean {
    return (
      this.sidebarView?.visible === true || this.editor?.panel.visible === true
    );
  }

  /** Whether the sidebar shows a conversation or the New-task state. */
  private sidebarShowsProgress(): boolean {
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
    if (this.editor) {
      this.editor.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    if (!options?.inPlace) await this.showInSidebar();
    // Showing progress from the launcher means showing a conversation: the
    // newest stream, the one the sidebar would open on by itself.
    if (this.sidebarShowsProgress()) return;
    const newest = SubscriptionRef.getUnsafe(this.session.view).order.at(0);
    if (newest !== undefined) {
      this.surfaceAction({ kind: 'select', streamId: newest });
    }
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
    if (this.editor) {
      this.editor.panel.reveal(vscode.ViewColumn.One);
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
    const port = this.attach('editor', panel);
    this.editor = { panel, port };
    port.disposables.push(
      panel.onDidDispose(() => {
        this.closePort(port);
        this.editor = undefined;
      }),
    );
  }

  public dispose(): void {
    this.closeSidebarPort();
    this.closePort(this.editor?.port);
    this.editor?.panel.dispose();
    this.editor = undefined;
    this.bridge.dispose();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    if (ProgressViewProvider._instance === this) {
      ProgressViewProvider._instance = undefined;
    }
  }
}
