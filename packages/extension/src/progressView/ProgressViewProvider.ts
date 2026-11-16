/** The sidebar and editor tab render one session; this provider owns their
 * ports, host snapshot, request handling, and onboarding presentation. */
import * as path from 'node:path';

import * as vscode from 'vscode';
import { Deferred, Effect, Exit, FileSystem, Scope, Stream } from 'effect';

import { scopedFork } from '@texra-ai/harness/host';
import { withLogChannel } from '@texra-ai/harness/plugins';
import {
  attentionOf,
  ensureError,
  formatResultCount,
  type AgentConfig,
  type FileLocation,
  type RunId,
  type SessionView,
} from '@texra-ai/harness/schemas';
import { VscodeToolEditApprovalHost } from '@frontend/approval/VscodeToolEditApprovalHost';
import {
  createAgentPresentationHost,
  warnOnFailure,
} from '@frontend/events/agentEventListeners';
import { openBuilt, type ShowBuilt } from '@frontend/latex/openBuild';
import { getLinterMessages } from '@frontend/latex/linter';
import { executeVscodeCommand } from '@frontend/system/commandUtils';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { eventStream } from '@frontend/vscode/vscodeEvents';
import { isDocumentTaskRun } from '@texra/shared/plugins/documents';
import { sectionCountLabel } from '@ui/copy/runStatus';
import { hostFailed } from '@texra/controllers/session/hostCallFailure';
import type { HostFailed } from '@texra/hosts/uiHosts';
import { setOnboardingDeclined } from '@texra/controllers/onboarding/onboardingFunnel';
import {
  EXTENSION_CATEGORIES,
  getFilterExtensions,
} from '@texra/common/files/fileTypeUtils';
import {
  PdfOpenFailed,
  type EditorCapabilities,
  type ManualCriticismEntry,
} from '@texra/tools/editorHost';
import { projectDisplayOf } from '@texra/shared/session/hostSnapshot';
import type { DownWire } from '@texra/shared/session/sessionFrames';
import type { HostRunActions } from '@texra/controllers/session/hostRunActions';
import { HostDraftRequests } from '@texra/controllers/session/hostDraftRequests';
import type { HostSnapshotSource } from '@texra/controllers/session/hostSnapshotSource';
import {
  openGuiWindow,
  type GuiSession,
  type GuiWindowSettingsRuns,
} from '@texra/controllers/session/openGuiWindow';
import type {
  AttachedPort,
  SessionBridge,
} from '@texra/controllers/session/SessionBridge';
import { workspaceFileOptions } from '@texra/controllers/session/workspaceFileOptions';
import { BundledViewContentProvider } from '../common/webview/BundledViewContentProvider';

import {
  createExtensionHostRequests,
  type ExtensionHostRequestsOptions,
} from './extensionHostRequests';
import type { Session, WorkspaceRoots } from '@texra-ai/harness';
import type {
  ProcessRuntime,
  ProcessServices,
  ScopedFork,
  StateStore,
} from '@texra-ai/harness/host';

const CHANNEL = 'ProgressViewProvider';

/** The toast that names a run when its progress view cannot be revealed:
 *  the run's agent, model and files. */
function launchNotice(config: AgentConfig): string {
  const primaryInput = config.inputFiles[0];
  const inputName = primaryInput
    ? path.basename(primaryInput)
    : 'selected input';
  const { outputFiles } = config;
  let outputPart = '';
  if (outputFiles.length > 1) {
    outputPart = ` (to ${outputFiles.length} files)`;
  } else if (outputFiles[0]) {
    outputPart = ` (to ${path.basename(outputFiles[0])})`;
  }
  return `"${config.agent}" is processing ${inputName} with ${config.model}${outputPart}.`;
}

/** Focus the sidebar view. */
const showInSidebar: Effect.Effect<void, HostFailed> = executeVscodeCommand(
  'texra.mainView.focus',
).pipe(
  Effect.asVoid,
  Effect.mapError((cause) => hostFailed('showInSidebar', cause)),
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
  readonly settingsRuns: GuiWindowSettingsRuns;
  /** Where this window's runs run: the service's session, or this one. */
  readonly runSession: Session;
  /** The view's scope: each surface's scope is a child of it, so the
   *  surfaces close first when it does. */
  readonly scope: Scope.Scope;
  readonly contentProvider: BundledViewContentProvider;
  readonly globalState: StateStore;
  readonly runtime: ProcessRuntime;
  /** The view's run function: a surface's posts and messages start their
   *  work there, so a request a surface sent outlives that surface and
   *  ends with the view. */
  readonly fork: ScopedFork<ProcessServices>;
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
      /** Process runtime shared with every extension surface. */
      runtime: ProcessRuntime,
      /** The window's roots: its workspace, storage and settings stores. */
      roots: WorkspaceRoots,
      /** Where this window's runs run: the service's session, or this
       *  process's own with the handle that owns it. */
      windowSession: GuiSession,
      /** Add an agent's entry to the editor's criticism diagnostics;
       *  false while they are off. */
      addCriticism: (entry: ManualCriticismEntry) => boolean,
      /** The settings view's verbs this view's cards and links run. The
       *  settings view is built after this one, so each waits for it. */
      settings: Pick<
        ExtensionHostRequestsOptions,
        'openSettings' | 'signInSubscription'
      >,
    ) {
      const scope = yield* Scope.Scope;
      const fork = yield* scopedFork<ProcessServices>();
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
        addCriticism: (payload) => Effect.sync(() => addCriticism(payload)),
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
      // "Show a built file" for every caller in this window: a scheduled PDF
      // viewer opens in the view's scope, so a close of the view cancels an
      // open still waiting.
      const showBuilt: ShowBuilt = (locations, options) =>
        openBuilt(roots, locations, options).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
      const focusChanged = eventStream(
        vscode.window.onDidChangeWindowState,
      ).pipe(
        Stream.filter((state) => state.focused),
        Stream.as(undefined),
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
        },
        // The tool-edit preview: staged copies of the original and proposed
        // content the diff editor shows, for each tool edit the session
        // where the runs run lists, until the view drops it or the window
        // goes.
        toolEdits: new VscodeToolEditApprovalHost(
          path.join(storageRoot.fsPath, 'tool-edit-previews'),
          fork,
          showBuilt,
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
            showBuilt,
            notices: createAgentPresentationHost(roots, runtime, showBuilt),
            window: editor,
            runtime,
            extensionPath: context.extensionPath,
            extensionId: context.extension.id,
            ...settings,
            showConnectModel: () => onView((view) => view.showConnectModel()),
            showProgressView: () => onView((view) => view.showProgressView()),
            revealProgress: (config) =>
              onView((view) => view.revealProgress(config)),
            popOutToEditor: () => onView((view) => view.popOutToEditor()),
            showInSidebar: () => showInSidebar,
          }),
      });
      const view = new ProgressViewProvider({
        bridge: gui.bridge,
        snapshot: gui.snapshot,
        runValidated: gui.runValidated,
        settingsRuns: gui.settingsRuns,
        runSession,
        scope,
        contentProvider,
        globalState: roots.globalState,
        runtime,
        fork,
      });
      yield* Deferred.succeed(built, view);
      yield* Effect.forkScoped(view.followAttention());
      yield* view.followWorkspace();
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
  /** The settings view's verbs on this window's runs. */
  public readonly settingsRuns: GuiWindowSettingsRuns;
  /** Where this window's runs run: the service's session, or this one. */
  private readonly runSession: Session;

  /** The sidebar's badge: the requests this window can answer. */
  private badge: vscode.ViewBadge | undefined;

  private readonly globalState: StateStore;
  private readonly runtime: ProcessRuntime;
  private readonly fork: ScopedFork<ProcessServices>;
  private constructor(parts: ViewParts) {
    this.bridge = parts.bridge;
    this.snapshot = parts.snapshot;
    this.scope = parts.scope;
    this.contentProvider = parts.contentProvider;
    this.credentialUsable = parts.snapshot.credentialUsable;
    this.runValidated = parts.runValidated;
    this.settingsRuns = parts.settingsRuns;
    this.runSession = parts.runSession;
    this.globalState = parts.globalState;
    this.runtime = parts.runtime;
    this.fork = parts.fork;
  }

  // --- The host snapshot's producers ---

  /** Follow the workspace for the view's lifetime: its files and its
   *  folders. */
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
    const filesChanged = Stream.unwrap(
      Effect.acquireRelease(
        Effect.sync(() =>
          vscode.workspace.createFileSystemWatcher(filePattern),
        ),
        (fileWatcher) => Effect.sync(() => fileWatcher.dispose()),
      ).pipe(
        Effect.map((fileWatcher) =>
          Stream.merge(
            eventStream(fileWatcher.onDidCreate),
            eventStream(fileWatcher.onDidDelete),
          ),
        ),
      ),
    );
    // Only a non-first workspace folder can be added or removed here: VS
    // Code restarts the extension host for a first-folder change, so the
    // storage root never moves under a live window (#11432).
    const foldersChanged = eventStream(
      vscode.workspace.onDidChangeWorkspaceFolders,
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
  });

  // --- Ports ---

  /** The sidebar slot: VS Code resolves it once per document. */
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
      localResourceRoots: this.contentProvider.localResourceRoots,
    };
    webviewView.badge = this.badge;
    // The slot is VS Code's own synchronous entry: it hands back a resolved
    // view, so the attachment finishes here.
    this.runtime.runSync(this.attach('sidebar', webviewView));
  }

  /** Attach `view` as the `id` surface, replacing one attached there; when
   *  VS Code disposes the view, its scope closes. */
  private readonly attach = Effect.fn('ProgressViewProvider.attach')(
    { self: this },
    function* (
      id: keyof Surfaces,
      view: vscode.WebviewView | vscode.WebviewPanel,
    ): Effect.fn.Return<void, HostFailed, FileSystem.FileSystem> {
      this.closeSurface(this.surfaces[id]);
      // The post starts synchronously inside the fork, so sends keep their
      // order.
      const send = (message: DownWire): void => {
        this.fork(
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
      const attached = yield* this.bridge
        .attach({ id, send })
        .pipe(Effect.mapError((cause) => hostFailed('attach', cause)));
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
          this.fork(attached.receive(message));
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
      yield* showInSidebar;
      this.surfaces.sidebar?.attached.surfaceAction({ kind: 'submit' });
    },
  );

  /**
   * Bring a surface forward: the tab while it is attached, else the
   * sidebar. A reveal the user asked for takes focus; one the window
   * makes on its own (`preserveFocus`) leaves it where the user is typing,
   * so a focused card's single-key answers do not catch keystrokes meant
   * for the editor.
   */
  private reveal(preserveFocus: boolean): Effect.Effect<void, HostFailed> {
    const { editor, sidebar } = this.surfaces;
    const host = (member: string, call: () => void) =>
      Effect.try({
        try: call,
        catch: (cause) => hostFailed(member, cause),
      });
    if (editor)
      return host('reveal', () => editor.view.reveal(undefined, preserveFocus));
    // A quiet reveal shows a resolved sidebar in place; one that takes focus
    // runs the focus command, which also opens a collapsed container.
    if (sidebar && preserveFocus)
      return host('reveal', () => sidebar.view.show(true));
    return showInSidebar;
  }

  /** Follow the session for the view's lifetime: the sidebar's badge counts
   *  the requests this window can answer, a new one brings its run on
   *  screen without taking focus, and a document task that completes, here
   *  or in the service, plays the chime. The card stays the one place to
   *  answer; nothing here decides a request. */
  private followAttention(): Effect.Effect<void> {
    // Unseeded: the first view is what was already pending when the window
    // subscribed, which the badge shows and nothing reveals.
    let previous: SessionView | undefined;
    return Stream.runForEach(this.runSession.view.changes, (view) => {
      const { requests, arrived, finished } = attentionOf(view, previous);
      previous = view;
      this.setBadge(requests.length);
      // A failed or stopped task is no chime.
      if (
        finished.some(
          (run) => isDocumentTaskRun(run) && run.outcome === 'completed',
        )
      )
        this.chime();
      const [first] = arrived;
      return first ? this.bringForward(first.runId) : Effect.void;
    });
  }

  private setBadge(count: number): void {
    if (count === (this.badge?.value ?? 0)) return;
    this.badge =
      count === 0
        ? undefined
        : {
            value: count,
            tooltip: sectionCountLabel(
              'waiting',
              formatResultCount(count, 'request'),
            ),
          };
    const sidebar = this.surfaces.sidebar?.view;
    if (sidebar) sidebar.badge = this.badge;
  }

  /** Bring a waiting request's run on screen without taking focus. A
   *  failure is warn-logged, so the attention follower survives to keep the
   *  badge current. */
  private bringForward(runId: RunId): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (this.visibleSurface() === undefined) yield* this.reveal(true);
      // A surface on the New-task state opens this run, visible or just
      // revealed; one showing a session keeps it, and its run tabs mark the
      // one waiting.
      this.bridge.surfaceAction({ kind: 'showSessions', runId });
    }).pipe(
      Effect.catch((failure) =>
        Effect.logWarning(
          `A waiting request could not be revealed: ${failure.message}`,
        ).pipe(withLogChannel(CHANNEL)),
      ),
    );
  }

  /**
   * Bring the progress view into view for a run this window just started
   * (the run actions' `revealProgress`), or name the run in a toast when it
   * cannot be made visible.
   */
  public readonly revealProgress = Effect.fn(
    'ProgressViewProvider.revealProgress',
  )({ self: this }, function* (config: AgentConfig) {
    if (this.visibleSurface() !== undefined) return;
    // A failed reveal is a diagnostic, not non-delivery: fall through to the
    // visibility re-check and the toast (#10554).
    yield* warnOnFailure(
      this.showProgressView(),
      'Failed to reveal the progress view',
    );
    // Delivery is the reveal actually becoming visible, not the reveal
    // command resolving.
    if (this.visibleSurface() !== undefined) return;
    // The toast is the delivered surface when the view cannot be made
    // visible, even if the user dismisses it without retrying the reveal.
    const selection = yield* vscodeUi.ask('info', launchNotice(config), {
      modal: false,
      detail:
        'TeXRA agents run in the background; track them under Tasks in the TeXRA panel.',
      items: ['Show Tasks'],
    });
    if (!selection) return;
    yield* warnOnFailure(
      this.showProgressView(),
      'Failed to retry the progress-view reveal',
    );
  });

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
      yield* showInSidebar;
      this.bridge.surfaceAction({ kind: 'selectNew' });
    },
  );

  public readonly showProgressView = Effect.fn(
    'ProgressViewProvider.showProgressView',
  )({ self: this }, function* () {
    const hadTab = this.surfaces.editor !== undefined;
    yield* this.reveal(false);
    if (hadTab) return;
    // Each surface decides from its own selection: one on the New-task
    // state opens the newest session, one showing a session keeps it.
    const newest = this.runSession.view.current().order.at(0);
    if (newest !== undefined)
      this.bridge.surfaceAction({ kind: 'showSessions', runId: newest });
  });

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
