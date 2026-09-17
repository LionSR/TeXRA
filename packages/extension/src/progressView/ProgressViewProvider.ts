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
import { Effect, Exit, Fiber, Scope, Stream, SubscriptionRef } from 'effect';

import { getAgent, refresh } from '@agent/index';
import type { AgentTrace } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import {
  attachTerminalResultToast,
  PdfOpenFailed,
  type SessionHandle,
} from '@agent/runtime';
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
import {
  ToolEditApprovalController,
  type ToolEditApprovalHost,
} from '@controllers/approval/ToolEditApprovalController';
import { HostDraftRequests } from '@controllers/session/hostDraftRequests';
import { OnboardingFunnelRefresher } from '@controllers/onboarding/onboardingFunnel';
import {
  SessionBridge,
  type AttachedPort,
} from '@controllers/session/SessionBridge';
import {
  createHostSnapshotSource,
  HostSnapshotReadFailed,
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
import type { StateStore } from '@platform/interfaces';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import {
  agentKeyOf,
  AgentCategory,
  type SessionType,
  type RunId,
} from '@shared/schemas';
import { projectDisplayOf } from '@shared/session/hostSnapshot';
import type {
  DownMessage,
  SurfaceActionMessage,
} from '@shared/session/sessionFrames';
import { debounce } from '@utils/core';
import { DEBOUNCE_OPTIONS_MS } from '@utils/config/constants';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { checkCoreDependencies } from '@utils/system/toolUtils';

import { createExtensionHostRequests } from './extensionHostRequests';

const RECENT_COMMIT_LIMIT = 20;

const log = createLog('ProgressViewProvider');

export type ProgressRunRevealResult = 'revealed' | 'missing';

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

  /** The bridge's lifetime: every port and request it owns ends when
   *  {@link dispose} closes it. */
  private readonly bridgeScope = Scope.makeUnsafe();
  private readonly contentProvider: BundledViewContentProvider;
  private readonly logger: AgentTrace;
  private readonly disposables: vscode.Disposable[] = [];

  /** The sidebar's `WebviewView` while VS Code holds one resolved. */
  private sidebarView: vscode.WebviewView | undefined;
  private sidebarPort: Port | undefined;
  /** The popped-out tab and its port, attached and released together. */
  private editor: { panel: vscode.WebviewPanel; port: Port } | undefined;

  /**
   * This host's half of the shared funnel loop (PRD: agent-native
   * onboarding): its credential sources, its user-scoped flag store, and the
   * two things it does with a recomputed funnel — paint it into the host
   * snapshot, and on entering State 1 select the setup agent on the launcher.
   * It never auto-starts setup; the user launches it from the setup card.
   */
  private readonly onboardingFunnel: OnboardingFunnelRefresher;
  private readonly debouncedRefreshCatalogs = debounce(
    () => void this.refreshCatalogs(),
    DEBOUNCE_OPTIONS_MS,
  );

  constructor(
    private readonly context: vscode.ExtensionContext,
    /** The platform state port, wrapped once by the extension root from the
     *  editor's global `Memento`. */
    private readonly globalState: StateStore,
    private readonly secrets: PlatformSecrets,
    /** This view's handle on the process runtime, handed down by the host
     *  entry for the session edges below. */
    private readonly runtime: ProcessRuntime,
    /** The extension host's one session, created in `activate` and handed
     *  down to every surface that needs it. */
    session: SessionHandle,
  ) {
    this.logger = createChannelTrace('ProgressViewProvider');
    this.session = session;
    this.contentProvider = new BundledViewContentProvider(
      context,
      runtime,
      'ProgressView',
      'progressView',
    );
    this.onboardingFunnel = new OnboardingFunnelRefresher({
      hasCredential: () => hasAnyUsableSetupCredential(secrets),
      flags: globalState,
      apply: (transition) => {
        this.snapshot.setOnboarding(transition.state);
        if (!transition.selectSetupAgent) return;
        // Resolve the qualified registry key so the dropdown matches by
        // value; the plain name still resolves by label if the registry
        // isn't loaded.
        const entry = getAgent('setup', AgentCategory.ToolUse);
        this.surfaceAction({
          kind: 'launch',
          patch: {
            sessionType: 'toolUse',
            agent: { toolUse: entry ? agentKeyOf(entry) : 'setup' },
          },
        });
      },
    });

    // Install the recipient before host requests publish the recorder's state.
    this.bridge = this.runtime.runSync(
      SessionBridge.make({
        session,
        handleHostRequest: (request, port) =>
          hostRequests.handle(request, port),
        onPortClosed: (port) => hostRequests.closePort(port),
      }).pipe(Scope.provide(this.bridgeScope)),
    );
    const roots = session.roots;
    this.snapshot = createHostSnapshotSource({
      project: projectDisplayOf(session.roots.storage, roots.workspace),
      globalState,
      workspaceState: roots.workspaceState,
      secrets,
      fileOptions: () =>
        workspaceFileOptions(roots.workspace).pipe(
          Effect.mapError(
            (cause) =>
              new HostSnapshotReadFailed({
                member: 'fileOptions',
                message: 'The workspace file lists could not be read.',
                cause,
              }),
          ),
        ),
      readRecentCommits: () =>
        Effect.tryPromise({
          try: async () => {
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
          catch: (cause) =>
            new HostSnapshotReadFailed({
              member: 'readRecentCommits',
              message: 'The recent commits could not be read.',
              cause,
            }),
        }),
      workspaceRoots: () =>
        vscode.workspace.workspaceFolders?.map((folder) => ({
          label: folder.name,
          value: folder.uri.fsPath,
        })) ?? [],
      debugMode: isDebugModeEnabled,
      // Already an Effect program: the typed port lets the banner read it
      // directly instead of settling it on the runtime first.
      apiKeyBanner: () =>
        hasUsableSetupCredential(this.secrets, (message) =>
          log.warn(message),
        ).pipe(
          Effect.map((usable) => ({ visible: !usable })),
          Effect.mapError(
            (cause) =>
              new HostSnapshotReadFailed({
                member: 'apiKeyBanner',
                message: 'The provider credential status could not be read.',
                cause,
              }),
          ),
        ),
      dependencyBanner: () =>
        Effect.tryPromise({
          try: async () => {
            const missingTools = await checkCoreDependencies(false);
            return {
              visible: missingTools.length > 0,
              missingTools: [...missingTools],
            };
          },
          catch: (cause) =>
            new HostSnapshotReadFailed({
              member: 'dependencyBanner',
              message: 'The external tool dependencies could not be probed.',
              cause,
            }),
        }),
      onError: (error) => {
        this.logger.error('Host snapshot refresh failed', { data: error });
      },
      publish: (snapshot) => {
        this.runtime.runFork(this.bridge.setHost(snapshot));
      },
    });
    const storageRoot = context.storageUri ?? context.globalStorageUri;
    // The tool-edit preview: staged copies of the original and proposed
    // content the diff editor shows. The request itself is the session's
    // (`request.opened` folds into the view) and this host's decision goes
    // back as that request's `request.decide`; the staged preview is
    // discarded when `request.decided` folds, whichever way it went.
    const decideRequest: ToolEditApprovalHost['decide'] = (
      runId,
      requestId,
      decision,
    ) =>
      this.runtime.runPromise(
        session.requests
          .request({ kind: 'request.decide', runId, requestId, decision })
          .pipe(Effect.asVoid),
      );
    this.toolEditApprovals = new ToolEditApprovalController({
      host: new VscodeToolEditApprovalHost(
        path.join(storageRoot.fsPath, 'tool-edit-previews'),
        decideRequest,
        this.runtime,
        session,
      ),
    });
    // A workflow run's `run.end` is the completion chime, one per process
    // (PRD 12.4), never a renderer transition hook that every subscriber
    // would replay. A failed run does not chime.
    const sessionEvents = this.runtime.runFork(
      Stream.runForEach(session.events.all(session.now()), (event) =>
        Effect.sync(() => {
          this.toolEditApprovals.handleSessionEvent(event);
          if (
            event.type === 'run.end' &&
            event.output.category === 'workflow' &&
            event.outcome !== 'failed'
          ) {
            this.chime();
          }
        }),
      ),
    );
    this.disposables.push({
      dispose: () => {
        this.runtime.runFork(Fiber.interrupt(sessionEvents));
      },
    });

    const hostRequests = createExtensionHostRequests({
      session,
      runtime: this.runtime,
      extensionPath: context.extensionPath,
      globalState,
      secrets,
      snapshot: this.snapshot,
      draftRequests: new HostDraftRequests(),
      toolEditApprovals: this.toolEditApprovals,
      surfaceAction: (action) => this.surfaceAction(action),
      popOutToEditor: () => this.popOutToEditor(),
      showInSidebar: () => this.showInSidebar(),
      refreshOnboardingFunnel: () => this.refreshOnboardingFunnel(),
    });
    this.disposables.push({ dispose: () => hostRequests.dispose() });

    // Attached for the window's life, before the first run of this window
    // asks anything. Requests this host does not present (bash, plan,
    // proposal, retry, question) stay pending in the fold until the view's
    // request row decides them.
    const detachHostInteractions = session.interactions.use({
      ...createAgentPresentationHost(this, globalState, this.runtime, session),
      readDiagnostics: getLinterMessages,
      addCriticism: (payload) => ({
        accepted: pushManualCriticism(payload),
        resolvedPath: payload.absolutePath,
      }),
      openPdf: ({ location, preserveFocus }) =>
        Effect.tryPromise({
          try: async () => {
            await vscode.commands.executeCommand(
              'vscode.open',
              vscode.Uri.file(location.absolutePath),
              {
                viewColumn: vscode.ViewColumn.Beside,
                preserveFocus,
              } satisfies vscode.TextDocumentShowOptions,
            );
          },
          catch: (cause) =>
            new PdfOpenFailed({
              path: location.absolutePath,
              message: 'VS Code would not open the PDF in its viewer.',
              cause,
            }),
        }),
      // Findings from the changeReviewer tool-use session flow in through
      // the report_review_issue tool and land in the panel + diagnostics.
      reportReviewIssue: (report) => AgentReviewService.addIssueReport(report),
      // Staging is the host's half of a `request.opened`; the fold lists the
      // request either way, so a staging failure is reported, never swallowed.
      presentToolEdit: (request) => {
        const staged = Effect.tryPromise(() =>
          this.toolEditApprovals.present(request),
        );
        this.runtime.runFork(
          staged.pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                this.logger.error('Tool edit preview staging failed', {
                  data: error.cause,
                });
              }),
            ),
          ),
        );
      },
      // An open that never committed leaves the staged preview with no
      // decision to release it; this is that release, and the promise it
      // returns is what the session waits on: closing the diff view and
      // deleting the temp files behind it is asynchronous.
      releaseToolEdit: (requestId) => this.toolEditApprovals.release(requestId),
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
    await this.runtime.runPromise(this.snapshot.refresh);
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
        void this.runtime.runPromise(this.snapshot.refreshFiles);
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
    const refreshFiles = () =>
      void this.runtime.runPromise(this.snapshot.refreshFiles);
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
            this.runtime.runPromise(this.snapshot.refreshCatalogs),
            this.runtime.runPromise(this.snapshot.refreshAuth),
            this.refreshOnboardingFunnel(),
          ]);
        });
        return;
      }
      void this.refreshAfterCredentialChange();
    });
  }

  /** Every credential-dependent surface: catalogs, sign-in, the funnel. */
  private async refreshAfterCredentialChange(): Promise<void> {
    await this.runtime.runPromise(refresh());
    await Promise.all([
      this.runtime.runPromise(this.snapshot.refreshCatalogs),
      this.runtime.runPromise(this.snapshot.refreshAuth),
      this.runtime.runPromise(this.snapshot.refreshHostBanners),
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
    if (!options.agentCatalogAlreadyFresh) {
      await this.runtime.runPromise(refresh());
    }
    await this.runtime.runPromise(this.snapshot.refreshCatalogs);
    if (options.selectedToolUseAgent) {
      this.surfaceAction({
        kind: 'launch',
        patch: { agent: { toolUse: options.selectedToolUseAgent } },
      });
    }
  }

  /** The API-key banner after a key changed in Settings. */
  public refreshHostBanners(): Promise<void> {
    return this.runtime.runPromise(this.snapshot.refreshHostBanners);
  }

  /** A run loaded an agent from the custom directory. */
  public showAgentConfigBanner(
    agentName: string,
    sessionType: SessionType,
  ): void {
    this.snapshot.showAgentConfigBanner(agentName, sessionType);
  }

  /** Recompute the user-scoped funnel; the shared refresher owns the loop. */
  public refreshOnboardingFunnel(): Promise<void> {
    return this.runtime.runPromise(this.onboardingFunnel.run());
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
    const attached = this.runtime.runSync(this.bridge.attach({ id, send }));
    // The template is read off this tick (it never rejects: a failed render
    // is a logged error page); a port closed before it lands paints nothing.
    let open = true;
    const disposables: vscode.Disposable[] = [
      view.webview.onDidReceiveMessage((message) => {
        this.runtime.runFork(attached.receive(message));
      }),
      {
        dispose: () => {
          open = false;
        },
      },
    ];
    void this.contentProvider
      .getHtmlContent(view.webview, {
        sessionKey: this.bridge.key,
        placement: id,
      })
      .then((html) => {
        if (open) view.webview.html = html;
      });
    return { attached, disposables, send };
  }

  private closePort(port: Port | undefined): void {
    if (!port) return;
    for (const disposable of port.disposables) disposable.dispose();
    this.runtime.runFork(port.attached.close);
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
      this.surfaceAction({ kind: 'select', runId: newest });
    }
  }

  /** Select a stream this window just launched (the launch's
   *  `onRunResolved` callback): the launching surface selects it. */
  public presentLaunchedRun(runId: RunId): void {
    this.surfaceAction({ kind: 'select', runId });
  }

  public async revealRun(runId: RunId): Promise<ProgressRunRevealResult> {
    const view = SubscriptionRef.getUnsafe(this.session.view);
    if (!view.runs.has(runId)) return 'missing';
    await this.showProgressView();
    this.surfaceAction({ kind: 'select', runId });
    return 'revealed';
  }

  public runLabel(runId: RunId): string | undefined {
    return SubscriptionRef.getUnsafe(this.session.view).runs.get(runId)?.label;
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
    this.runtime.runFork(Scope.close(this.bridgeScope, Exit.void));
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    if (ProgressViewProvider._instance === this) {
      ProgressViewProvider._instance = undefined;
    }
  }
}
