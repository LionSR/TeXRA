/** The sidebar and editor tab render one session; this provider owns their
 * ports, host snapshot, request handling, and onboarding presentation. */
import * as path from 'node:path';

import * as vscode from 'vscode';
import {
  Cause,
  Data,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import { getCategoryAgent, refresh } from '@agent/index';
import {
  attachTerminalResultToast,
  PdfOpenFailed,
  type SessionHandle,
} from '@agent/runtime';
import { hasAnyUsableSetupCredential } from '@commands/setup/setupAssistantCommand';
import {
  BundledViewContentProvider,
  getCombinedLocalResourceRoots,
  getSharedLocalResourceRoots,
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
import { withLogChannel } from '@logger/effectLog';
import { createLog } from '@logger/logUtils';
import { hasUsableSetupCredential } from '@model/setupCredentialAccess';
import { Lifecycle, SHUTDOWN_PHASE } from '@platform/interfaces';
import type {
  StateStore,
  StateReadFailed,
  StateWriteFailed,
} from '@platform/interfaces';
import type { LanguageModel } from '@platform/languageModel';
import { withProcessServices } from '@platform/processRuntime';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
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
import { allSettledVoid } from '@utils/core/allSettledVoid';
import { createFlushableDebounce } from '@utils/core';
import { DEBOUNCE_OPTIONS_MS } from '@utils/config/constants';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { checkCoreDependencies } from '@utils/system/checkCoreDependencies';

import { createExtensionHostRequests } from './extensionHostRequests';

const RECENT_COMMIT_LIMIT = 20;

const CHANNEL = 'ProgressViewProvider';
const log = createLog(CHANNEL);

export type ProgressRunRevealResult = 'revealed' | 'missing';

/** One transport port: a VS Code webview attached to the bridge. */
/**
 * A placement the window refused: the sidebar focus command, or a tab
 * attaching to a bridge that has closed. Tagged because these reach the
 * request channel, whose failures are tags without exception.
 */
export class SurfacePlacementFailed extends Data.TaggedError(
  'SurfacePlacementFailed',
)<{
  readonly member: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

interface Port {
  readonly attached: AttachedPort;
  readonly disposables: vscode.Disposable[];
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
  private readonly debouncedRefreshCatalogs = createFlushableDebounce(
    () => void this.runtime.runPromise(this.refreshCatalogs()),
    DEBOUNCE_OPTIONS_MS,
  );

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly globalState: StateStore,
    private readonly secrets: PlatformSecrets,
    /** Process runtime shared with every extension surface. */
    private readonly runtime: ProcessRuntime,
    /** Session created by the extension entry. */
    session: SessionHandle,
    public readonly refreshApiKeyStatus: Effect.Effect<
      void,
      Error,
      ProcessServices
    >,
  ) {
    this.session = session;
    this.contentProvider = new BundledViewContentProvider(
      context,
      'ProgressView',
      'progressView',
    );
    this.onboardingFunnel = new OnboardingFunnelRefresher({
      hasCredential: () => hasAnyUsableSetupCredential(session.roots, secrets),
      flags: globalState,
      apply: (transition) =>
        Effect.gen({ self: this }, function* () {
          yield* this.snapshot.setOnboarding(transition.state);
          if (!transition.selectSetupAgent) return;
          // Resolve the registry key so the dropdown matches by value.
          const entry = getCategoryAgent(AgentCategory.ToolUse, 'setup');
          this.surfaceAction({
            kind: 'launch',
            patch: {
              sessionType: 'toolUse',
              agent: entry ? agentKeyOf(entry) : 'setup',
            },
          });
        }),
    });

    // Install the recipient before host requests publish the recorder's state.
    this.bridge = this.runtime.runSync(
      SessionBridge.make({
        session,
        handleHostRequest: (request, port) =>
          hostRequests.handleHostRequest(request, port),
        onPortClosed: (port) => hostRequests.closePort(port),
      }).pipe(Scope.provide(this.bridgeScope)),
    );
    const roots = session.roots;
    this.snapshot = createHostSnapshotSource({
      project: projectDisplayOf(session.roots.storage, roots.workspace),
      stores: roots,
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
      // Already an Effect program: the typed port lets the banner read it
      // directly instead of settling it on the runtime first.
      apiKeyBanner: () =>
        hasUsableSetupCredential(this.session.roots, this.secrets)
          .pipe(withLogChannel('Setup Credentials'))
          .pipe(
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
      // Already an Effect program, and one that answers a failed probe as a
      // missing tool rather than failing, so the banner reads it directly.
      dependencyBanner: () =>
        checkCoreDependencies(false).pipe(
          Effect.map((missingTools) => ({
            visible: missingTools.length > 0,
            missingTools: [...missingTools],
          })),
        ),
      onError: (error) => {
        log.error('Host snapshot refresh failed', { data: error });
      },
      publish: (snapshot) => this.bridge.setHost(snapshot),
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
      session.requests
        .request({ kind: 'request.decide', runId, requestId, decision })
        .pipe(Effect.asVoid);
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
        this.toolEditApprovals.handleSessionEvent(event).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (
                event.type === 'run.end' &&
                event.output.category === 'workflow' &&
                event.outcome !== 'failed'
              ) {
                this.chime();
              }
            }),
          ),
        ),
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
      refreshApiKeyStatus: this.refreshApiKeyStatus,
    });
    this.disposables.push({ dispose: () => hostRequests.dispose() });

    // Attached for the window's life, before the first run of this window
    // asks anything. Requests this host does not present (bash, plan,
    // proposal, retry, question) stay pending in the fold until the view's
    // request row decides them.
    const detachHostInteractions = this.runtime.runSync(
      session.interactions.use({
        ...createAgentPresentationHost(
          this,
          globalState,
          this.runtime,
          session,
        ),
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
        reportReviewIssue: (report) =>
          AgentReviewService.addIssueReport(report),
        // Staging is the host's half of a `request.opened`; the fold lists the
        // request either way, so a staging failure is reported, never swallowed.
        presentToolEdit: (request) => {
          this.runtime.runFork(
            this.toolEditApprovals
              .present(request)
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logError('Tool edit preview staging failed').pipe(
                    Effect.annotateLogs({ data: Cause.squash(cause) }),
                    withLogChannel(CHANNEL),
                  ),
                ),
              ),
          );
        },
        // An open that never committed leaves the staged preview with no
        // decision to release it; this is that release, composed into the
        // session's own program rather than run here: closing the diff view
        // and deleting the temp files behind it is asynchronous, and the
        // refusal is not reported until it is done. The controller's programs
        // take this window's services from the runtime's context, which the
        // session that composes them does not carry.
        releaseToolEdit: (requestId) =>
          Effect.flatMap(this.runtime.contextEffect, (context) =>
            Effect.provideContext(
              this.toolEditApprovals.release(requestId),
              context,
            ),
          ),
      }),
    );
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
    );

    this.watchWorkspace();
    ProgressViewProvider._instance = this;
  }

  public static getInstance(): ProgressViewProvider | undefined {
    return this._instance;
  }

  public initialize() {
    return Effect.gen({ self: this }, function* () {
      // `ON` phase, behind the run settlement activation registered earlier.
      (yield* Lifecycle).onShutdown(
        SHUTDOWN_PHASE.ON,
        withProcessServices(this.runtime, this.dispose()),
      );
      yield* this.snapshot.refresh;
      yield* this.refreshOnboardingFunnel();
      yield* Effect.logDebug('ProgressViewProvider initialized').pipe(
        withLogChannel(CHANNEL),
      );
    });
  }

  // --- The host snapshot's producers ---

  private watchWorkspace(): void {
    // Only a non-first workspace folder can be added or removed here: VS
    // Code restarts the extension host for a first-folder change, so the
    // storage root never moves under a live window (#11432).
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.runtime.runPromise(
          this.snapshot
            .refreshWorkspaceRoots()
            .pipe(Effect.andThen(this.snapshot.refreshFiles)),
        );
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
        this.debouncedRefreshCatalogs.schedule(),
      ),
    );
    onTexraAuthSessionsChanged(this.context, () => {
      if (isAgentCatalogAuthRefreshDeferred()) {
        runAfterAgentCatalogAuthRefresh(this.runtime, [
          this.snapshot.refreshCatalogs,
          this.snapshot.refreshAuth,
          this.refreshOnboardingFunnel(),
        ]);
        return;
      }
      this.runtime.runFork(this.refreshAfterCredentialChange());
    });
  }

  /** Every credential-dependent surface: catalogs, sign-in, the funnel. */
  private refreshAfterCredentialChange() {
    return Effect.gen({ self: this }, function* () {
      yield* refresh({ includeRemote: true });
      // Let every surface finish repainting even when another one fails.
      yield* allSettledVoid<
        StateReadFailed | StateWriteFailed,
        ProcessServices
      >([
        this.snapshot.refreshCatalogs,
        this.snapshot.refreshAuth,
        this.snapshot.refreshHostBanners,
        this.refreshOnboardingFunnel(),
      ]);
    });
  }

  /** The agent, team, and model catalogs (`texra.refreshAllOptions`). */
  public refreshCatalogs(
    options: {
      agentCatalogAlreadyFresh?: boolean;
      selectedToolUseAgent?: string;
    } = {},
  ) {
    return Effect.suspend(() =>
      options.agentCatalogAlreadyFresh ? Effect.void : refresh(),
    ).pipe(
      Effect.andThen(this.snapshot.refreshCatalogs),
      Effect.andThen(
        Effect.sync(() => {
          const agent = options.selectedToolUseAgent;
          if (agent)
            this.surfaceAction({
              kind: 'launch',
              patch: { sessionType: 'toolUse', agent },
            });
        }),
      ),
    );
  }

  /** A run loaded an agent from the custom directory. */
  public showAgentConfigBanner(
    agentName: string,
    sessionType: SessionType,
  ): Effect.Effect<void> {
    return this.snapshot.showAgentConfigBanner(agentName, sessionType);
  }

  /** Recompute the user-scoped funnel; the shared refresher owns the loop. */
  public refreshOnboardingFunnel(): Effect.Effect<
    void,
    StateReadFailed | StateWriteFailed,
    LanguageModel
  > {
    return this.onboardingFunnel.run();
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
    // The slot is VS Code's own synchronous entry: it hands back a resolved
    // view, so the attachment settles here.
    this.sidebarPort = this.runtime.runSync(
      this.attach('sidebar', webviewView),
    );
    this.sidebarPort.disposables.push(
      webviewView.onDidDispose(() => {
        this.closeSidebarPort();
        this.sidebarView = undefined;
      }),
    );
  }

  private attach(
    id: 'sidebar' | 'editor',
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): Effect.Effect<Port, SurfacePlacementFailed, FileSystem.FileSystem> {
    return Effect.gen({ self: this }, function* () {
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
      const attached = yield* this.bridge.attach({ id, send }).pipe(
        Effect.mapError(
          (cause) =>
            new SurfacePlacementFailed({
              member: 'attach',
              message: toErrorMessage(cause),
              cause,
            }),
        ),
      );
      // The template is read off this tick (it never fails: a failed render
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
      yield* Effect.forkDetach(
        this.contentProvider
          .getHtmlContent(view.webview, {
            sessionKey: this.bridge.key,
            placement: id,
          })
          .pipe(
            Effect.flatMap((html) =>
              Effect.sync(() => {
                if (open) view.webview.html = html;
              }),
            ),
          ),
      );
      return { attached, disposables };
    });
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
    port?.attached.surfaceAction({ kind: 'chime' });
  }

  /** `texra.execute` with no configuration (Cmd+Alt+E): the composer's
   *  Send in the view the user is in, which is the visible surface and its
   *  own draft. With none showing, the sidebar, shown first so the action
   *  has a surface to land on. */
  public submit() {
    return Effect.gen({ self: this }, function* () {
      const port = this.visibleSurfacePort();
      if (port !== undefined && port === this.editor?.port) {
        port.attached.surfaceAction({ kind: 'submit' });
        return;
      }
      yield* this.showInSidebar();
      this.sidebarPort?.attached.surfaceAction({ kind: 'submit' });
    });
  }

  public isViewVisible(): boolean {
    return (
      this.sidebarView?.visible === true || this.editor?.panel.visible === true
    );
  }

  public showInSidebar(): Effect.Effect<void, SurfacePlacementFailed> {
    return Effect.tryPromise({
      try: async () => {
        await vscode.commands.executeCommand('texra.mainView.focus');
      },
      catch: (cause) =>
        new SurfacePlacementFailed({
          member: 'showInSidebar',
          message: toErrorMessage(cause),
          cause,
        }),
    });
  }

  /** The New-task state in the sidebar (`texra.showMainView`). */
  public showLauncher() {
    return Effect.gen({ self: this }, function* () {
      yield* this.showInSidebar();
      this.surfaceAction({ kind: 'selectNew' });
    });
  }

  public showProgressView(options?: { inPlace?: boolean }) {
    return Effect.gen({ self: this }, function* () {
      if (this.editor) {
        this.editor.panel.reveal(vscode.ViewColumn.One);
        return;
      }
      if (!options?.inPlace) yield* this.showInSidebar();
      // Each surface decides from its own selection: one on the New-task
      // state opens the newest session, one showing a session keeps it.
      const newest = SubscriptionRef.getUnsafe(this.session.view).order.at(0);
      if (newest !== undefined) {
        this.surfaceAction({ kind: 'showSessions', runId: newest });
      }
    });
  }

  /** Select a stream this window just launched (the launch's
   *  `onRunResolved` callback): the launching surface selects it. */
  public presentLaunchedRun(runId: RunId): void {
    this.surfaceAction({ kind: 'select', runId });
  }

  public revealRun(
    runId: RunId,
  ): Effect.Effect<ProgressRunRevealResult, SurfacePlacementFailed> {
    return Effect.gen({ self: this }, function* () {
      const view = SubscriptionRef.getUnsafe(this.session.view);
      if (!view.runs.has(runId)) return 'missing' as const;
      yield* this.showProgressView();
      this.surfaceAction({ kind: 'select', runId });
      return 'revealed' as const;
    });
  }

  public runLabel(runId: RunId): string | undefined {
    return SubscriptionRef.getUnsafe(this.session.view).runs.get(runId)?.label;
  }

  public popOutToEditor() {
    return Effect.gen({ self: this }, function* () {
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
      const port = yield* this.attach('editor', panel);
      this.editor = { panel, port };
      port.disposables.push(
        panel.onDidDispose(() => {
          this.closePort(port);
          this.editor = undefined;
        }),
      );
    });
  }

  /** Awaits the staged tool-edit preview files' removal: runtime disposal
   *  follows the shutdown drain and would cut a forked release short. */
  private dispose(): Effect.Effect<void, never, ProcessServices> {
    return Effect.gen({ self: this }, function* () {
      this.closeSidebarPort();
      this.closePort(this.editor?.port);
      this.editor?.panel.dispose();
      this.editor = undefined;
      yield* Scope.close(this.bridgeScope, Exit.void);
      for (const disposable of this.disposables.splice(0)) disposable.dispose();
      yield* this.toolEditApprovals.dispose();
      if (ProgressViewProvider._instance === this) {
        ProgressViewProvider._instance = undefined;
      }
    });
  }
}
