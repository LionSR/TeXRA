/** The sidebar and editor tab render one session; this provider owns their
 * ports, host snapshot, request handling, and onboarding presentation. */
import * as path from 'node:path';

import * as vscode from 'vscode';
import {
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Queue,
  Schema,
  Scope,
  Stream,
} from 'effect';

import { AgentCatalog, withLogChannel } from '@texra-ai/harness/host';
import {
  ensureError,
  toErrorMessage,
  agentKeyOf,
  type FileLocation,
  type RunId,
} from '@texra-ai/harness/schemas';
import { AppSignals, appSignalStream } from '@texra-ai/harness/host';
import { VscodeToolEditApprovalHost } from '@frontend/approval/VscodeToolEditApprovalHost';
import {
  createAgentPresentationHost,
  revealProgressView,
} from '@frontend/events/agentEventListeners';
import { pushManualCriticism } from '@frontend/latex/inlineCriticism';
import { getLinterMessages } from '@frontend/latex/linter';
import { executeVscodeCommand } from '@frontend/system/commandUtils';
import { setOnboardingDeclined } from '@texra/controllers/onboarding/onboardingFunnel';
import {
  EXTENSION_CATEGORIES,
  getFilterExtensions,
} from '@texra/common/files/fileTypeUtils';
import {
  PdfOpenFailed,
  type EditorCapabilities,
} from '@texra/tools/editorHost';
import { projectDisplayOf } from '@texra/shared/session/hostSnapshot';
import type { SettingsTarget } from '@texra/shared/settingsView/settingsTarget';
import type { DownWire } from '@texra/shared/session/sessionFrames';
import type { HostRunActions } from '@texra/controllers/session/hostRunActions';
import { HostDraftRequests } from '@texra/controllers/session/hostDraftRequests';
import type { HostSnapshotSource } from '@texra/controllers/session/hostSnapshotSource';
import {
  openGuiWindow,
  type GuiSession,
} from '@texra/controllers/session/openGuiWindow';
import type {
  AttachedPort,
  SessionBridge,
} from '@texra/controllers/session/SessionBridge';
import { workspaceFileOptions } from '@texra/controllers/session/workspaceFileOptions';
import { checkCoreDependencies } from './checkCoreDependencies';
import { BundledViewContentProvider } from '../common/webview/BundledViewContentProvider';

import { createExtensionHostRequests } from './extensionHostRequests';
import { RequestAttention } from './requestAttention';
import type { Session, WorkspaceRoots } from '@texra-ai/harness';
import type {
  ProcessRuntime,
  ProcessServices,
  StateStore,
} from '@texra-ai/harness/host';

const CHANNEL = 'ProgressViewProvider';
const CATALOG_RESCAN_FAILED =
  'Agent catalog rescan after an agent-directory change failed';

type ProgressRunRevealResult = 'revealed' | 'missing';

/**
 * A placement the window refused: the sidebar focus command, or a tab
 * attaching to a bridge that has closed. Tagged because these reach the
 * request channel, whose failures are tags without exception.
 */
class SurfacePlacementFailed extends Schema.TaggedError<SurfacePlacementFailed>()(
  'SurfacePlacementFailed',
  {
    member: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** Focus the sidebar view. */
const showInSidebar: Effect.Effect<void, SurfacePlacementFailed> =
  executeVscodeCommand('texra.mainView.focus').pipe(
    Effect.asVoid,
    Effect.mapError(
      (cause) =>
        new SurfacePlacementFailed({
          member: 'showInSidebar',
          message: cause.message,
          cause,
        }),
    ),
  );

/** One surface: a VS Code webview attached to the bridge as a port. */
interface Surface<View extends vscode.WebviewView | vscode.WebviewPanel> {
  readonly view: View;
  readonly attached: AttachedPort;
  /** The port's lifetime: its listeners, its page render and its entry in
   *  the provider's surfaces end when this closes. */
  readonly scope: Scope.Closeable;
}

/** The two surfaces by placement, each present while attached. */
interface Surfaces {
  sidebar?: Surface<vscode.WebviewView>;
  editor?: Surface<vscode.WebviewPanel>;
}

/** What the view is built over: its window's parts and the scope it lives
 *  in. */
interface ViewParts {
  readonly bridge: SessionBridge;
  readonly snapshot: HostSnapshotSource;
  readonly runValidated: HostRunActions['runValidated'];
  /** Where this window's runs run: the service's session, or this one. */
  readonly runSession: Session;
  /** The view's scope: each surface's scope is a child of it, so the
   *  surfaces close first when it does. */
  readonly scope: Scope.Scope;
  readonly contentProvider: BundledViewContentProvider;
  readonly globalState: StateStore;
  readonly runtime: ProcessRuntime;
}

export class ProgressViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'texra.mainView';

  /**
   * Build the view in a child of the caller's scope, which owns all of it:
   * the recorder, the window (bridge, snapshot, tool-edit previews), the
   * followers and the workspace watchers. It closes where the caller's
   * scope reaches the point this was built at: the surfaces first, then
   * everything built here, last-in first-out.
   */
  static readonly make = Effect.fn('ProgressViewProvider.make')(
    function* (
      context: vscode.ExtensionContext,
      globalState: StateStore,
      /** Process runtime shared with every extension surface. */
      runtime: ProcessRuntime,
      /** The window's roots: its workspace, storage and settings stores. */
      roots: WorkspaceRoots,
      /** Where this window's runs run: the service's session, or this
       *  process's own with the handle that owns it. */
      windowSession: GuiSession,
      /** The settings view at a target. The settings view is built after
       *  this one, so this waits for it. */
      openSettings: (
        target: SettingsTarget | undefined,
      ) => Effect.Effect<void, Error, ProcessServices>,
    ) {
      const scope = yield* Scope.Scope;
      const signals = yield* AppSignals;
      const catalog = yield* AgentCatalog;
      const draftRequests = yield* HostDraftRequests.make;
      const contentProvider = new BundledViewContentProvider(
        context,
        'ProgressView',
        'progressView',
      );
      const runSession = windowSession.session;
      const storageRoot = context.storageUri ?? context.globalStorageUri;
      // The host's verbs that place or reveal a surface act on the view, which
      // is built over the window they are part of: they wait for it.
      const built = yield* Deferred.make<ProgressViewProvider>();
      const onView = <A, E, R>(
        act: (view: ProgressViewProvider) => Effect.Effect<A, E, R>,
      ) => Effect.flatMap(Deferred.await(built), act);
      // What this window does for a run, whether it runs here or in the
      // service: notices, and the editor's diagnostics, inline criticism and
      // PDF viewer, which the editor tools read through the registry.
      const editor: EditorCapabilities = {
        readDiagnostics: getLinterMessages,
        addCriticism: (payload) =>
          Effect.sync(() => pushManualCriticism(payload)),
        openPdf: ({
          location,
          preserveFocus,
        }: {
          readonly location: FileLocation;
          readonly preserveFocus: boolean;
        }) =>
          executeVscodeCommand(
            'vscode.open',
            vscode.Uri.file(location.absolutePath),
            {
              viewColumn: vscode.ViewColumn.Beside,
              preserveFocus,
            } satisfies vscode.TextDocumentShowOptions,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new PdfOpenFailed({
                  path: location.absolutePath,
                  message: 'VS Code would not open the PDF in its viewer.',
                  cause,
                }),
            ),
          ),
      };
      const focusChanged = Stream.callback<void>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() =>
            vscode.window.onDidChangeWindowState((state) => {
              if (state.focused) Queue.offerUnsafe(queue, undefined);
            }),
          ),
          (listener) => Effect.sync(() => listener.dispose()),
        ),
      );
      const gui = yield* openGuiWindow({
        runs: windowSession,
        roots,
        project: projectDisplayOf(roots.storage, roots.workspace),
        snapshot: {
          fileOptions: () => workspaceFileOptions(roots.workspace),
          workspaceRoots: () =>
            vscode.workspace.workspaceFolders?.map((folder) => ({
              label: folder.name,
              value: folder.uri.fsPath,
            })) ?? [],
          shows: { apiKeyBanner: true, gettingStarted: true },
          // A failed probe reads as a missing tool, so the read never fails.
          missingTools: () => checkCoreDependencies(),
        },
        // The tool-edit preview: staged copies of the original and proposed
        // content the diff editor shows, for each tool edit the session
        // where the runs run lists, until the view drops it or the window
        // goes.
        toolEdits: new VscodeToolEditApprovalHost(
          path.join(storageRoot.fsPath, 'tool-edit-previews'),
          runtime,
          roots,
          scope,
        ),
        focused: Stream.suspend(() =>
          vscode.window.state.focused
            ? Stream.concat(Stream.succeed(undefined), focusChanged)
            : focusChanged,
        ),
        draftRequests,
        host: (parts) =>
          createExtensionHostRequests({
            ...parts,
            runSession,
            roots,
            window: {
              ...createAgentPresentationHost(
                parts.snapshot,
                globalState,
                runtime,
                roots,
                scope,
              ),
              ...editor,
              // What a service task wrote, told here as a task here tells
              // it: the file decorations follow it.
              filesWritten: (absolutePaths) =>
                signals.emit('workspaceFilesWritten', {
                  absolutePaths: [...absolutePaths],
                }),
            },
            runtime,
            extensionPath: context.extensionPath,
            extensionId: context.extension.id,
            openSettings,
            globalState,
            showConnectModel: () => onView((view) => view.showConnectModel()),
            showProgressView: () => onView((view) => view.showProgressView()),
            revealProgress: (config) =>
              onView((view) => revealProgressView(config, view)),
            popOutToEditor: () => onView((view) => view.popOutToEditor()),
            showInSidebar: () => showInSidebar,
          }),
      });
      const view = new ProgressViewProvider({
        bridge: gui.bridge,
        snapshot: gui.snapshot,
        runValidated: gui.runValidated,
        runSession,
        scope,
        contentProvider,
        globalState,
        runtime,
      });
      yield* Deferred.succeed(built, view);
      yield* Effect.forkScoped(view.attention.follow(runSession));
      yield* view.followWorkspace();
      // Entering State 1 selects the setup agent on the launcher; a
      // snapshot already in State 1 leaves a user who switched agents alone.
      // It never starts setup: the user launches it from the setup card.
      yield* Effect.forkScoped(
        gui.snapshot.changes.pipe(
          Stream.map((snapshot) => snapshot.onboarding),
          Stream.changes,
          Stream.filter((state) => state === 'setup'),
          Stream.runForEach(() =>
            Effect.sync(() => {
              // Resolve the registry key so the dropdown matches by value.
              const entry = catalog.get('setup');
              view.bridge.surfaceAction({
                kind: 'launch',
                patch: { agent: entry ? agentKeyOf(entry) : 'setup' },
              });
            }),
          ),
        ),
      );
      yield* gui.snapshot.refresh;
      yield* Effect.logDebug('ProgressViewProvider initialized').pipe(
        withLogChannel(CHANNEL),
      );
      return view;
    },
    (build) =>
      Effect.flatMap(Scope.Scope, (owner) =>
        Effect.flatMap(Scope.fork(owner), (scope) =>
          Scope.provide(build, scope),
        ),
      ),
  );

  private readonly bridge: SessionBridge;
  private readonly snapshot: HostSnapshotSource;
  private readonly scope: Scope.Scope;
  private readonly contentProvider: BundledViewContentProvider;

  /** The sidebar while VS Code holds one resolved, and the popped-out tab;
   *  an entry leaves when its surface's scope closes. */
  private readonly surfaces: Surfaces = {};
  /** Whether a usable credential exists, as each check answers: the setup
   *  pill follows the answer the "Connect a model" card reads. */
  public readonly credentialUsable: Stream.Stream<boolean>;
  /** The window's launcher (`HostRunActions.runValidated`). */
  public readonly runValidated: HostRunActions['runValidated'];
  /** Where this window's runs run: the service's session, or this one. */
  private readonly runSession: Session;
  /** A credential may have changed: check it again, with the host's other
   *  banners. The funnel, the banner and the setup pill follow the answer. */
  public readonly refreshApiKeyStatus: HostSnapshotSource['refreshHostBanners'];

  private readonly attention = new RequestAttention({
    sidebar: () => this.surfaces.sidebar?.view,
    panel: () => this.surfaces.editor?.view,
    isViewVisible: () => this.isViewVisible(),
    showInSidebar: () => showInSidebar,
    showSessions: (runId) =>
      this.bridge.surfaceAction({ kind: 'showSessions', runId }),
    chime: () => this.chime(),
  });

  private readonly globalState: StateStore;
  private readonly runtime: ProcessRuntime;
  private constructor(parts: ViewParts) {
    this.bridge = parts.bridge;
    this.snapshot = parts.snapshot;
    this.scope = parts.scope;
    this.contentProvider = parts.contentProvider;
    this.credentialUsable = parts.snapshot.credentialUsable;
    this.runValidated = parts.runValidated;
    this.runSession = parts.runSession;
    this.refreshApiKeyStatus = parts.snapshot.refreshHostBanners;
    this.globalState = parts.globalState;
    this.runtime = parts.runtime;
  }

  // --- The host snapshot's producers ---

  /** Follow the workspace for the view's lifetime: its files, its folders
   *  and its agents. */
  private readonly followWorkspace = Effect.fn(
    'ProgressViewProvider.followWorkspace',
  )({ self: this }, function* () {
    // Watch exactly the categories the launcher file lists are built from
    // (fileListingRules), including user-configured extension overrides, so
    // the watched set cannot drift from what the lists display.
    const extensions = new Set(
      EXTENSION_CATEGORIES.flatMap(getFilterExtensions),
    );
    const filePattern =
      extensions.size === 0 ? '**/*' : `**/*.{${[...extensions].join(',')}}`;
    // One listing per burst of creates and deletes: a checkout that adds
    // a thousand files lists the workspace once, not a thousand times.
    const filesChanged = Stream.callback<void>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const fileWatcher =
            vscode.workspace.createFileSystemWatcher(filePattern);
          const changed = () => Queue.offerUnsafe(queue, undefined);
          fileWatcher.onDidCreate(changed);
          fileWatcher.onDidDelete(changed);
          return fileWatcher;
        }),
        (fileWatcher) => Effect.sync(() => fileWatcher.dispose()),
      ),
    );
    // Only a non-first workspace folder can be added or removed here: VS
    // Code restarts the extension host for a first-folder change, so the
    // storage root never moves under a live window (#11432).
    const foldersChanged = Stream.callback<void>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          vscode.workspace.onDidChangeWorkspaceFolders(() =>
            Queue.offerUnsafe(queue, undefined),
          ),
        ),
        (listener) => Effect.sync(() => listener.dispose()),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(foldersChanged, () =>
        this.snapshot.refreshWorkspaceRoots.pipe(
          Effect.andThen(this.snapshot.refreshFiles),
        ),
      ),
    );
    yield* Effect.forkScoped(
      filesChanged.pipe(
        Stream.debounce('300 millis'),
        Stream.runForEach(() => this.snapshot.refreshFiles),
      ),
    );
    // The catalog reloads itself on every change to its sources
    // (`agentCatalogFollower`); this launcher repaints what it lists, at
    // most once per 300ms burst of changes.
    yield* Effect.forkScoped(
      appSignalStream('workspaceAgentsChanged').pipe(
        Stream.debounce('300 millis'),
        Stream.runForEach(() =>
          this.refreshCatalogs({ agentCatalogAlreadyFresh: true }).pipe(
            Effect.ignore({ log: 'Warn', message: CATALOG_RESCAN_FAILED }),
          ),
        ),
        withLogChannel(CHANNEL),
      ),
    );
  });

  /** The agent, team, and model catalogs. */
  public refreshCatalogs(
    options: {
      agentCatalogAlreadyFresh?: boolean;
      selectedAgent?: string;
    } = {},
  ) {
    return Effect.suspend(() =>
      options.agentCatalogAlreadyFresh
        ? Effect.void
        : AgentCatalog.use((catalog) => catalog.refresh),
    ).pipe(
      Effect.andThen(this.snapshot.refreshCatalogs),
      Effect.andThen(
        Effect.sync(() => {
          const agent = options.selectedAgent;
          if (agent)
            this.bridge.surfaceAction({ kind: 'launch', patch: { agent } });
        }),
      ),
    );
  }

  // --- Ports ---

  /** The sidebar slot: VS Code resolves it once per document. */
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
      localResourceRoots: this.contentProvider.localResourceRoots,
    };
    this.attention.paint(webviewView);
    // The slot is VS Code's own synchronous entry: it hands back a resolved
    // view, so the attachment settles here.
    this.runtime.runSync(this.attach('sidebar', webviewView));
  }

  /** Attach `view` as the `id` surface, replacing one attached there; when
   *  VS Code disposes the view, its scope closes. */
  private readonly attach = Effect.fn('ProgressViewProvider.attach')(
    { self: this },
    function* (
      id: keyof Surfaces,
      view: vscode.WebviewView | vscode.WebviewPanel,
    ): Effect.fn.Return<void, SurfacePlacementFailed, FileSystem.FileSystem> {
      this.closeSurface(this.surfaces[id]);
      // The post starts synchronously inside runFork, so sends keep their order.
      const send = (message: DownWire): void => {
        this.runtime.runFork(
          Effect.tryPromise({
            try: () => view.webview.postMessage(message),
            catch: ensureError,
          }).pipe(
            Effect.flatMap((delivered) =>
              delivered
                ? Effect.void
                : Effect.logWarning(
                    `A ${message.kind} message was not delivered to ${id}`,
                  ),
            ),
            Effect.catch((error) =>
              Effect.logWarning(
                `Posting a ${message.kind} message to ${id} failed: ${error.message}`,
              ),
            ),
            withLogChannel(CHANNEL),
          ),
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
      const surface = { view, attached, scope: yield* Scope.fork(this.scope) };
      // cast: each caller passes the view its placement holds (the sidebar's
      // `WebviewView`, the tab's `WebviewPanel`).
      Object.assign(this.surfaces, { [id]: surface } as Surfaces);
      // The tab is the one surface this window created, so it goes when its
      // port does, after everything else the port held. VS Code owns the
      // sidebar's view.
      if ('dispose' in view)
        yield* Scope.addFinalizer(
          surface.scope,
          Effect.sync(() => view.dispose()),
        );
      yield* Scope.addFinalizer(
        surface.scope,
        Effect.andThen(
          Effect.sync(() => {
            if (this.surfaces[id] === surface) delete this.surfaces[id];
          }),
          attached.close,
        ),
      );
      // The template is read off this tick (it never fails: a failed render
      // is a logged error page); a port closed before it lands paints nothing,
      // because closing the port interrupts the render. The listeners are
      // registered after the render, so closing removes them first.
      yield* Effect.forkIn(
        this.contentProvider
          .getHtmlContent(view.webview, {
            sessionKey: this.bridge.key,
            placement: id,
          })
          .pipe(
            Effect.flatMap((html) =>
              Effect.sync(() => {
                view.webview.html = html;
              }),
            ),
          ),
        surface.scope,
      );
      for (const listener of [
        view.onDidDispose(() => this.closeSurface(surface)),
        view.webview.onDidReceiveMessage((message) => {
          this.runtime.runFork(attached.receive(message));
        }),
      ])
        yield* Scope.addFinalizer(
          surface.scope,
          Effect.sync(() => listener.dispose()),
        );
    },
    withLogChannel(CHANNEL),
  );

  private closeSurface(
    surface: Surface<vscode.WebviewView | vscode.WebviewPanel> | undefined,
  ): void {
    if (surface) this.runtime.runFork(Scope.close(surface.scope, Exit.void));
  }

  /**
   * The one rule for which surface a host action lands on: the one the user
   * is looking at, the editor tab first while it is the active panel, then a
   * visible sidebar, then a visible tab. Attachment is not visibility here:
   * the sidebar keeps its port and its own webview state while hidden
   * (`retainContextWhenHidden`), so a hidden sidebar must not outrank the
   * tab on screen. `undefined` when no surface is showing.
   */
  private visibleSurface(): AttachedPort | undefined {
    const { sidebar, editor } = this.surfaces;
    if (editor?.view.active === true) return editor.attached;
    if (sidebar?.view.visible === true) return sidebar.attached;
    if (editor?.view.visible === true) return editor.attached;
    return undefined;
  }

  /** The completion chime plays once per process, in the surface the user is
   *  looking at. With none showing it still plays in a retained sidebar (or
   *  a hidden tab), which is the case a chime is for: a run the user walked
   *  away from. No port means no renderer to play it. */
  private chime(): void {
    const port =
      this.visibleSurface() ??
      this.surfaces.sidebar?.attached ??
      this.surfaces.editor?.attached;
    port?.surfaceAction({ kind: 'chime' });
  }

  /** `texra.execute` with no configuration (Cmd+Alt+E): the composer's
   *  Send in the view the user is in, which is the visible surface and its
   *  own draft. With none showing, the sidebar, shown first so the action
   *  has a surface to land on. */
  public readonly submit = Effect.fn('ProgressViewProvider.submit')(
    { self: this },
    function* () {
      const port = this.visibleSurface();
      if (port !== undefined && port === this.surfaces.editor?.attached) {
        port.surfaceAction({ kind: 'submit' });
        return;
      }
      yield* this.showInSidebar();
      this.surfaces.sidebar?.attached.surfaceAction({ kind: 'submit' });
    },
  );

  public isViewVisible(): boolean {
    const { sidebar, editor } = this.surfaces;
    return sidebar?.view.visible === true || editor?.view.visible === true;
  }

  public showInSidebar(): Effect.Effect<void, SurfacePlacementFailed> {
    return showInSidebar;
  }

  /**
   * "Connect a model" from outside the panel (the setup command, the status
   * pill): bring the one credential prompt into view. A previous "Skip for
   * now" is cleared so the card shows again on a first install; after a
   * finished task the credential-lost banner stands in its place.
   */
  public readonly showConnectModel = Effect.fn(
    'ProgressViewProvider.showConnectModel',
  )({ self: this }, function* () {
    yield* setOnboardingDeclined(this.globalState, false);
    yield* this.showLauncher();
  });

  /** The New-task state in the sidebar (`texra.showMainView`). */
  public readonly showLauncher = Effect.fn('ProgressViewProvider.showLauncher')(
    { self: this },
    function* () {
      yield* this.showInSidebar();
      this.bridge.surfaceAction({ kind: 'selectNew' });
    },
  );

  public readonly showProgressView = Effect.fn(
    'ProgressViewProvider.showProgressView',
  )({ self: this }, function* (options?: { inPlace?: boolean }) {
    if (this.surfaces.editor) {
      this.surfaces.editor.view.reveal(vscode.ViewColumn.One);
      return;
    }
    if (!options?.inPlace) yield* this.showInSidebar();
    // Each surface decides from its own selection: one on the New-task
    // state opens the newest session, one showing a session keeps it.
    const newest = this.runSession.view.current().order.at(0);
    if (newest !== undefined)
      this.bridge.surfaceAction({ kind: 'showSessions', runId: newest });
  });

  public readonly revealRun = Effect.fn('ProgressViewProvider.revealRun')(
    { self: this },
    function* (
      runId: RunId,
    ): Effect.fn.Return<ProgressRunRevealResult, SurfacePlacementFailed> {
      const view = this.runSession.view.current();
      if (!view.runs.has(runId)) return 'missing' as const;
      yield* this.showProgressView();
      this.bridge.surfaceAction({ kind: 'select', runId });
      return 'revealed' as const;
    },
  );

  public runLabel(runId: RunId): string | undefined {
    return this.runSession.view.current().runs.get(runId)?.label;
  }

  public readonly popOutToEditor = Effect.fn(
    'ProgressViewProvider.popOutToEditor',
  )({ self: this }, function* () {
    if (this.surfaces.editor) {
      this.surfaces.editor.view.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'texra.progress.panel',
      'TeXRA Tasks',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        enableCommandUris: true,
        retainContextWhenHidden: true,
        localResourceRoots: this.contentProvider.localResourceRoots,
      },
    );
    panel.iconPath = new vscode.ThemeIcon('pulse');
    yield* this.attach('editor', panel);
  });
}
