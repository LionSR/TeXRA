import { join, resolve as resolvePath } from 'node:path';
import { Scope } from 'effect';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeTheme,
  session,
  shell,
} from 'electron';

import { Cause, Data, Effect, Exit, Stream, SubscriptionRef } from 'effect';
import { z } from 'zod';
import { presentAgentFailure } from '@agent/runtime';
import {
  agentSourceDirectory,
  getAgentsByCategory,
  createWorkspaceAgentRosterController,
  loadAgents,
  refresh,
} from '@agent/index';
import type { SupabaseAuthShape } from '@auth/SupabaseAuth';
import {
  classifyAgentError,
  primaryAgentError,
} from '@common/errors/agentErrorClassification';
import { SignInFailed } from '@common/errors/signInFailed';
import { TeamCatalogPortFailed } from '@common/teams/TeamAvailabilityPreflight';
import {
  teamAvailabilityPrompt,
  type TeamAvailabilityPrompt,
} from '@common/teams/TeamPlan';
import type { PendingOAuthStore } from '@controllers/auth/pendingOAuthStore';
import { TranscriptExportFailed } from '@controllers/progressView/transcriptExportFailure';
import { LatexToolingController } from '@controllers/settingsView/LatexToolingController';
import {
  SessionBridge,
  type AttachedPort,
} from '@controllers/session/SessionBridge';
import {
  createHostSnapshotSource,
  HostSnapshotReadFailed,
} from '@controllers/session/hostSnapshotSource';
import { HostDraftRequests } from '@controllers/session/hostDraftRequests';
import { disposeProcessRuntime } from '@controllers/session/sessionLayer';
import {
  ExternalOpenFailed,
  NotificationFailed,
  PromptFailed,
} from '@hosts/uiHosts';
import { withLogChannel } from '@logger/effectLog';
import { hasUsableSetupCredential } from '@model/setupCredentialAccess';
import { DisposableStore } from '@platform/disposable';
import type {
  AgentDirectoriesPort,
  StateStore,
  StateWriteFailed,
  StateReadFailed,
} from '@platform/interfaces';
import {
  withProcessServices,
  type ProcessRuntime,
} from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import {
  INSTRUCTION_ACTION,
  RunIdSchema,
  type RunId,
  type AgentCategory,
  type AgentSource,
  type InstructionAction,
} from '@shared/schemas';
import { normalizePlatform } from '@shared/constants/latexToolchain';
import { Cancelled, Rejected } from '@shared/session/requestErrors';
import { registerRuntimeShutdownHandlers } from '@tools/agentCliSessionStores';
import { refreshToolAvailability } from '@tools/toolAvailability';
import { killActiveRecording } from '@tools/media/audio';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { findToolInCommonPaths } from '@utils/system/binaryResolver';
import {
  checkToolInstalled,
  detectPackageManager,
} from '@utils/system/toolUtils';
import {
  DesktopProjectRecords,
  openDesktopProjectRecords,
} from './desktopProjectRecords.js';
import { DesktopProcessResumeOwner } from './desktopAgentResume.js';
import { createDesktopDialogs } from './desktopDialogs.js';
import {
  DesktopAttentionPort,
  electronAttentionPort,
  followDesktopAttention,
} from './desktopAttention.js';
import {
  createDesktopDiffHost,
  removeExternalDiffPatchDirs,
} from './desktopDiffHost.js';
import { createDesktopFileSelection } from './desktopFileSelection.js';
import { createDesktopHostRequests } from './desktopHostRequests.js';
import { createDesktopAgentRun } from './desktopAgentRun.js';
import { installDesktopHostBridge } from './hostBridge.js';
import { createDesktopLogIpc } from './desktopLogIpc.js';
import { createDesktopProjectsIpc } from './desktopProjectsIpc.js';
import {
  isDesktopCommandMessage,
  type DesktopMessageHandler,
} from './desktopIpcTypes.js';
import {
  DesktopProjects,
  openDesktopProjectRegistry,
  readRememberedDesktopProjects,
  type DesktopProject,
  type DesktopProjectRegistry,
  type DesktopProjectsState,
} from './desktopProjects.js';
import { createDesktopPreviewHost } from './desktopPreviewHost.js';
import { createDesktopBrowserViews } from './desktopBrowserViews.js';
import { createDesktopPtyHost } from './desktopPtyHost.js';
import { createDesktopWorkspaceIpc } from './desktopWorkspaceIpc.js';
import {
  bootstrapDesktopWindowLifecycle,
  installDesktopBeforeQuitWiring,
} from './desktopWindowLifecycle.js';
import {
  DESKTOP_WORKSPACE_COMMANDS,
  DesktopWorkspaceInboundMessageSchema,
} from '../shared/desktopWorkspaceMessages.js';
import { DESKTOP_PROJECT_COMMANDS } from '../shared/desktopProjectMessages.js';
import { installDesktopProtocolCallbackLifecycle } from './desktopProtocolCallbacks.js';
import {
  attachRendererConsoleLog,
  getDesktopLogDirectory,
  readDesktopLogSnapshot,
} from './desktopAppLog.js';
import { installDesktopNavigationPolicy } from './desktopNavigationPolicy.js';
import {
  createDesktopOnboardingIpc,
  type DesktopOnboardingIpc,
} from './desktopOnboardingIpc.js';
import { DesktopPromptController } from './desktopPromptController.js';
import { DefaultDesktopAgentSettingsController } from './desktopAgentSettingsController.js';
import { DefaultDesktopCredentialSettingsController } from './desktopCredentialSettingsController.js';
import { desktopSignInPresenters } from './desktopSignInPresenters.js';
import {
  createDesktopSettingsIpc,
  type DesktopSettingsIpc,
  type DesktopSettingsUiHost,
} from './desktopSettingsIpc.js';
import { DefaultDesktopToolingSettingsController } from './desktopToolingSettingsController.js';
import { chooseDesktopOAuthProvider } from './desktopOAuthProviderPrompt.js';
import {
  createDesktopShellActions,
  createDesktopShellIpc,
} from './desktopShellIpc.js';
import {
  getDesktopWindowTitle,
  installDesktopWindowTitle,
} from './desktopWindowTitle.js';
import {
  checkForDesktopUpdate,
  DESKTOP_RELEASES_PAGE_URL,
} from './desktopUpdateChecker.js';
import {
  createDesktopPendingOAuthStore,
  createDesktopSupabaseAuth,
  type DesktopSupabaseAuthHost,
} from './desktopSupabaseAuth.js';
import { buildDesktopMenuTemplate } from './desktopMenuTemplate.js';
import {
  isFatalDesktopShutdownRequested,
  reportFatalStartupError,
} from './fatalStartupError.js';
import { initializeElectronPlatform } from './platform/index.js';
import { showDesktopWarningDialog } from './platform/warningDialog.js';
import {
  desktopInboundRoute,
  postDesktopSettingsView,
  type DesktopInboundRoute,
} from '../shared/desktopCommandSurface.js';
import type { DesktopSetupAuth } from './desktopSetupAuth.js';
import type { DesktopAgentRunHost } from './desktopAgentRunHost.js';

const moduleDirname = import.meta.dirname;
let mainWindow: BrowserWindow | null = null;
let reopenMainWindow: (() => void) | undefined;
/** Window-owned post-launch funnel refresh. The process resume owner reads
 *  this; createWindow assigns it when onboarding IPC exists. */
const afterLaunchFunnelRefresh: { current?: Effect.Effect<void> } = {};
let continueQuitAfterWindowClose: (() => void) | undefined;
// Playwright tests need a deterministic Electron profile so app-scoped stores
// survive across launches. Normal desktop launches keep Electron's default
// userData path.
const e2eUserDataPath = process.env.TEXRA_DESKTOP_E2E_USER_DATA_PATH;
if (e2eUserDataPath) {
  app.setPath('userData', resolvePath(e2eUserDataPath));
}

/** Show a run of a project in the window; the window assigns it. */
const revealProjectRun: { current?: (key: string, runId: RunId) => void } = {};

function focusOrReopenMainWindow(): void {
  if (!mainWindow) {
    reopenMainWindow?.();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

const protocolLifecycle = installDesktopProtocolCallbackLifecycle({
  app,
  argv: process.argv.slice(1),
  execPath: process.execPath,
  devAppArg: process.argv[1] ? resolvePath(process.argv[1]) : undefined,
  focusMainWindow: focusOrReopenMainWindow,
});

// The packaged renderer uses Lit style attributes and bundled font data URLs
// (codicons/KaTeX). Keep script run locked to app files while allowing
// those renderer primitives.
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' data:",
].join('; ');
const DEVELOPMENT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' data: ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*",
].join('; ');

function installContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          app.isPackaged ? PRODUCTION_CSP : DEVELOPMENT_CSP,
        ],
      },
    });
  });
}

/** The one field every session message carries: which project it names. */
const SessionMessageEnvelopeSchema = z.object({ session: z.string() });

// Recording has one process owner, shared by every project and window.
const hostDraftRequests = new HostDraftRequests();

function createWindow(options: {
  projects: DesktopProjectRegistry;
  /** The account plane served as `SupabaseAuth`, for the window's direct
   *  sign-in probes and the OAuth client it drives. */
  supabaseAuth: SupabaseAuthShape;
  /** The pending sign-in records, opened before the window so a deep link
   *  that launched the app can still be claimed. */
  pendingOAuthStore: PendingOAuthStore;
  /**
   * The process services the composition root built (see
   * `ElectronPlatformInitResult`). Handed down so the window's controllers and
   * IPC surfaces take their stores from their owner rather than re-reading
   * them.
   */
  globalState: StateStore;
  secrets: PlatformSecrets;
  agentDirectories: AgentDirectoriesPort;
  /** See ElectronPlatformInitResult.resourcesPath. */
  resourcesPath: string;
  /** See ElectronPlatformInitResult.mainDir. */
  mainDir: string;
  /**
   * The process runtime the composition root built. Every Effect this window
   * runs settles on it, and every handler and service below is handed it.
   */
  runtime: ProcessRuntime;
  /** See ElectronPlatformInitResult.setupAuth. */
  setupAuth: DesktopSetupAuth;
}): void {
  const activeProject = () => options.projects.active();
  // This window's handle on the process runtime, as its opener handed it over.
  const runtime = options.runtime;
  const initialProject = activeProject();
  const initialWindowTitle = getDesktopWindowTitle(
    initialProject.session,
    initialProject.root && initialProject.display.name,
  );
  const window = new BrowserWindow({
    // The task canvas remains useful with a project sidebar and an optional
    // workbench open beside it at the default size.
    width: 1280,
    height: 860,
    minWidth: 860,
    minHeight: 600,
    // Present the window only after Chromium has painted its first frame.
    // Relying on BrowserWindow's implicit show can strand a hidden-inset
    // window behind the launching macOS Space while the app itself is active.
    show: false,
    title: initialWindowTitle,
    // Frameless chrome. The OS title bar was a dead 28px strip in the app's own
    // color scheme that no amount of theming could reach, and it visually cut the
    // window off from the shell below it.
    //
    // `hiddenInset` (macOS) keeps the traffic-light buttons but removes the bar,
    // so the desktop shell header becomes the drag region. On Windows/Linux,
    // `titleBarOverlay` hands us the same arrangement with system controls
    // drawn over our surface.
    titleBarStyle: 'hiddenInset',
    // Inset the traffic lights so they sit centred in the 48px header rather
    // than crowding its top-left corner.
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 18, y: 18 } }
      : { titleBarOverlay: true }),
    // Match the operating-system theme before the renderer paints to avoid a
    // contrasting flash behind the frameless window.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#212121' : '#f7f7f7',
    webPreferences: {
      preload: join(options.mainDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  mainWindow = window;
  // Window root: every resource scoped to this BrowserWindow registers here at
  // creation, and the `closed` handler disposes the store (LIFO) instead of
  // running a hand-ordered teardown ledger.
  const windowResources = new DisposableStore();
  // Project root: the resources bound to the project the window shows (its
  // title, its settings surface and their subscriptions) live in this scope,
  // which is closed and replaced when the window switches projects.
  let projectScope: Scope.Closeable | undefined;
  let attachedProject: DesktopProject | undefined;
  windowResources.add(() => {
    attachedProject = undefined;
    settingsIpcRef.current = undefined;
    if (projectScope) runtime.runFork(Scope.close(projectScope, Exit.void));
  });
  const ipcRef: {
    current?: { postToRenderer(message: unknown): void };
  } = {};
  // `installDesktopHostBridge.postToRenderer` is itself a no-op when
  // `webContents.isDestroyed()`. Without checking that here too, callers would
  // falsely report success and skip their external-viewer fallback. Shared by
  // the prompt controller, preview host, agent-run wiring, and the
  // pty/browser-view workspace IPC below; the diff host keeps its own narrower
  // check (no `webContents.isDestroyed()`), so it is not folded in.
  const postToRendererIfAlive = (message: unknown): boolean => {
    const ipc = ipcRef.current;
    if (!ipc || window.isDestroyed() || window.webContents.isDestroyed()) {
      return false;
    }
    ipc.postToRenderer(message);
    return true;
  };
  const promptController = new DesktopPromptController({
    postToRenderer: postToRendererIfAlive,
  });
  const settingsIpcRef: {
    current?: DesktopSettingsIpc;
  } = {};
  const onboardingIpcRef: {
    current?: DesktopOnboardingIpc;
  } = {};
  /**
   * The onboarding funnel could not be recomputed. The funnel is host state
   * every open project's snapshot carries, so a refresh that faults leaves
   * the last state in place and is reported, not swallowed. `reportAsyncError`
   * shows `toErrorMessage` of this failure, so the message is the rejection's
   * own text rather than an empty tail.
   */
  class OnboardingRefreshFailed extends Data.TaggedError(
    'OnboardingRefreshFailed',
  )<{
    readonly message: string;
    readonly cause: unknown;
  }> {}
  const {
    showErrorMessage,
    showInfoMessage,
    showWarningMessage,
    confirmDialog,
    presentTeamAvailabilityPrompt,
    showErrorDialog,
    showInstructionDialog,
    pickTranscriptExportFormat,
  } = createDesktopDialogs(window, {
    openGuide: (docsCommand) =>
      openExternalInBackground(`https://texra.ai/guide/${docsCommand}`),
    dispatchInstructionAction: (action) => dispatchInstructionAction(action),
  });
  const reportAsyncError = (error: unknown) => {
    console.error('Desktop asynchronous operation failed:', error);
    runtime.runFork(
      showErrorMessage(
        `A desktop operation failed: ${toErrorMessage(error)}`,
      ).pipe(
        Effect.catch((notificationError: NotificationFailed) =>
          Effect.sync(() => {
            console.error(
              'Failed to display desktop asynchronous operation error:',
              notificationError,
            );
          }),
        ),
      ),
    );
  };
  const reportBackgroundError = (error: unknown) => {
    console.error('Desktop background operation failed:', error);
  };
  // Detached so the launch does not wait on it; reports its own defects.
  const refreshFunnelAfterLaunch: Effect.Effect<void> = Effect.suspend(() => {
    const refresh = onboardingIpcRef.current?.refreshOnboardingFunnel();
    if (!refresh) return Effect.void;
    return withProcessServices(runtime, refresh).pipe(
      Effect.catch((error: StateWriteFailed | StateReadFailed) =>
        Effect.sync(() => reportAsyncError(error)),
      ),
      Effect.catchDefect((defect) =>
        Effect.sync(() => reportAsyncError(defect)),
      ),
      Effect.forkDetach,
      Effect.asVoid,
    );
  });
  installDesktopNavigationPolicy(window.webContents, {
    onAsyncError: reportAsyncError,
  });
  // Lightweight update check: at most once/day, notifies at most once per
  // release via a native dialog linking to the GitHub release page. Not a full
  // updater: no download, no install, no feed files. Disable with
  // TEXRA_NO_UPDATE_CHECK=1. `createWindow` only ever runs inside the
  // `app.whenReady()` block, which the lock-losing process never reaches, so
  // no extra single-instance gate is needed here; `checkForDesktopUpdate`
  // itself dedupes concurrent calls and window reopens.
  runtime.runFork(
    checkForDesktopUpdate({
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      notify: async (release) => {
        const { response } = await dialog.showMessageBox(window, {
          type: 'info',
          message: `TeXRA ${release.version} is available (you have ${app.getVersion()}).`,
          buttons: ['Download', 'Later'],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 0) {
          // Open the known-constant releases page rather than any
          // network-provided URL, so an unauthenticated API response can
          // never influence what shell.openExternal opens.
          await shell.openExternal(DESKTOP_RELEASES_PAGE_URL);
        }
      },
    }).pipe(
      Effect.catch((error) => Effect.sync(() => reportBackgroundError(error))),
    ),
  );
  const previewOptions = {
    shell,
    runtime,
    // The in-app PDF overlay is preferred when the renderer is available.
    postToRenderer: postToRendererIfAlive,
  };
  const previewHost = createDesktopPreviewHost({
    ...previewOptions,
    showErrorMessage,
  });
  // Session requests present errors at their dispatcher. Menu, navigation,
  // and runtime preview callers retain the reporting host above.
  const requestPreviewHost = createDesktopPreviewHost(previewOptions);
  /** The custom agents directory the two shell surfaces open: the port's own
   *  program, so its `AgentDirectoriesFailed` travels with the caller that
   *  asked for it instead of being lifted back out of a settled promise. */
  const getCustomAgentDirectory = () => options.agentDirectories.custom();
  /**
   * The shell-facing `openExternal` worded for the {@link ExternalOpener}
   * port: the member is already a program, so this only names the failure.
   * `reportFailure: false` leaves the window's own "could not open" dialog
   * out, for a caller that reports the failure itself.
   */
  const openExternalProgram = (
    url: string,
    reportFailure: boolean,
  ): Effect.Effect<void, ExternalOpenFailed> =>
    previewHost.openExternal(url, { reportFailure }).pipe(
      Effect.catchTag('PreviewUnavailable', (cause) =>
        Effect.fail(
          new ExternalOpenFailed({
            kind: 'url',
            target: url,
            message: `The desktop could not open ${url} in the default browser: ${cause.message}`,
            cause,
          }),
        ),
      ),
    );
  /**
   * Open a documentation URL without keeping the caller waiting; the browser
   * never opening is reported, not swallowed. Its own wording, not
   * {@link openExternalProgram}'s: this report names the documentation URL
   * rather than the address the shell refused.
   */
  const openExternalInBackground = (url: string): void => {
    runtime.runFork(
      previewHost.openExternal(url).pipe(
        Effect.mapError(
          (cause) =>
            new ExternalOpenFailed({
              kind: 'url',
              target: url,
              message: 'The documentation URL could not be opened.',
              cause,
            }),
        ),
        // The handler's parameter is the whole error type this expression can
        // carry, so a second failure added here fails to compile instead of
        // reading as a documentation URL that would not open.
        Effect.catch((error: ExternalOpenFailed) =>
          Effect.sync(() => reportBackgroundError(error)),
        ),
      ),
    );
  };
  const dispatchInstructionAction = (action: InstructionAction): void => {
    switch (action) {
      case INSTRUCTION_ACTION.SET_API_KEY:
        postDesktopSettingsView(postToRendererIfAlive, 'models/keys');
        return;
      case INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE:
        openExternalInBackground('https://texra.ai/guide/configuration.html');
        return;
      case INSTRUCTION_ACTION.OPEN_MODELS_DOC:
        openExternalInBackground('https://texra.ai/guide/models.html');
        return;
    }
  };
  let teamSignInPending = false;
  /** Every surface an account change touches, as one program: the agent
   *  catalog, the settings view, then the onboarding funnel. */
  const refreshDesktopAuthSurfaces = () =>
    Effect.gen(function* () {
      // Sign-in: a signed-out load already stamped the catalog as including
      // remote, so only a forced refetch picks up the new account's agents.
      // Sign-out also lands here, after the coordinator dropped the remote
      // entries; refetching then would re-stamp a signed-out catalog.
      if (!teamSignInPending && (yield* options.supabaseAuth.authenticated)) {
        yield* refresh({ includeRemote: true });
      }
      yield* settingsIpcRef.current?.refreshAuthDependentData({
        deferAgentCatalogRefresh: teamSignInPending,
      }) ?? Effect.void;
      yield* onboardingIpcRef.current?.refreshOnboardingFunnel() ?? Effect.void;
    });
  const desktopAuthHost: DesktopSupabaseAuthHost = {
    openExternalUrl: (url) =>
      previewHost.openExternal(url, { reportFailure: false }),
    showInfoMessage,
    showErrorMessage,
    onSessionChanged: refreshDesktopAuthSurfaces,
  };
  const desktopAuth = windowResources.add(
    createDesktopSupabaseAuth({
      router: protocolLifecycle.router,
      auth: options.supabaseAuth,
      store: options.pendingOAuthStore,
      host: desktopAuthHost,
      runtime,
    }),
  );
  /**
   * Sole owner of the desktop sign-in provider choice. Every sign-in entry
   * point (login banner, credential settings, remote-agent catalog) routes
   * here so the desktop offers the same providers as the extension quick pick
   * and the CLI select instead of assuming one account type.
   */
  const chooseOAuthProvider = () =>
    chooseDesktopOAuthProvider((messageBoxOptions) =>
      dialog.showMessageBox(window, messageBoxOptions),
    );
  const signIn = (): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      const provider = yield* Effect.tryPromise({
        try: chooseOAuthProvider,
        catch: ensureError,
      });
      if (provider === undefined) return;
      yield* desktopAuth.signIn(provider);
    });
  const signInFailed = (cause: unknown) =>
    new SignInFailed({
      message: `The desktop sign-in could not run: ${toErrorMessage(cause)}`,
      cause,
    });
  const signInForRemoteAgentCatalog = (): Effect.Effect<
    boolean,
    SignInFailed
  > =>
    Effect.gen(function* () {
      const provider = yield* Effect.tryPromise({
        try: chooseOAuthProvider,
        catch: signInFailed,
      });
      if (provider === undefined) return false;
      teamSignInPending = true;
      return yield* Effect.gen(function* () {
        const signedIn = yield* desktopAuth.signInAndWaitForSession(provider);
        return signedIn && (yield* options.supabaseAuth.authenticated);
      }).pipe(
        Effect.mapError(signInFailed),
        Effect.ensuring(
          Effect.sync(() => {
            teamSignInPending = false;
          }),
        ),
      );
    });
  windowResources.add(
    options.setupAuth.registerSignIn(signInForRemoteAgentCatalog),
  );
  const folderPickerDefaultPath = () =>
    activeProject().root ?? app.getPath('home');

  const projectByKey = (key: string) =>
    options.projects.list().find((project) => project.key === key);
  const showDiscardDialog = () =>
    dialog.showMessageBoxSync(window, {
      type: 'warning',
      buttons: ['Keep Editing', 'Discard Changes'],
      defaultId: 0,
      cancelId: 0,
      title: 'Unsaved Changes',
      message: 'There are unsaved editor changes.',
      detail: 'Discard the changes and continue?',
    });

  /** Selection changes visibility; each project retains its tabs and processes. */
  const selectProject = (key: string) => {
    const project = projectByKey(key);
    if (!project || project.root === undefined || project === activeProject())
      return;
    runtime.runFork(
      options.projects
        .activate(project.root)
        .pipe(
          Effect.catch((error) => Effect.sync(() => reportAsyncError(error))),
        ),
    );
  };

  revealProjectRun.current = (key, runId) => {
    const project =
      key === options.projects.fallback().key
        ? options.projects.fallback()
        : projectByKey(key);
    if (!project) return;
    runtime.runFork(
      options.projects.activate(project.root).pipe(
        Effect.andThen(
          Effect.sync(() =>
            projectBindings
              .get(key)
              ?.bridge.surfaceAction({ kind: 'select', runId }),
          ),
        ),
        Effect.catch((error) => Effect.sync(() => reportAsyncError(error))),
      ),
    );
  };

  /** The renderer reports dirtiness for the addressed project, including a
   *  hidden one. Only explicit closure releases its resources. */
  const closeProject = (key: string, hasUnsavedChanges: boolean) => {
    const project = projectByKey(key);
    if (!project || project.root === undefined) return;
    if (hasUnsavedChanges && showDiscardDialog() !== 1) return;
    const root = project.root;
    runtime.runFork(
      options.projects
        .close(root)
        .pipe(
          Effect.catch((error) => Effect.sync(() => reportAsyncError(error))),
        ),
    );
  };

  /** Open a folder as a project and show it. */
  const openProjectAt = Effect.fn('desktop.openProjectAt')(function* (
    path: string,
  ) {
    const project = yield* options.projects.open(path);
    if (project.root !== undefined && project !== activeProject())
      yield* options.projects.activate(project.root);
  });
  const openWorkspaceFolder = Effect.fn('desktop.openWorkspaceFolder')(
    function* () {
      const result = yield* Effect.tryPromise({
        try: () =>
          dialog.showOpenDialog(window, {
            title: 'Open Workspace Folder',
            defaultPath: folderPickerDefaultPath(),
            properties: ['openDirectory'],
          }),
        catch: ensureError,
      });
      const selectedPath = result.canceled ? undefined : result.filePaths[0];
      if (!selectedPath) return;
      yield* openProjectAt(selectedPath);
    },
  );
  attachRendererConsoleLog(window.webContents);
  const desktopDiffHost = createDesktopDiffHost({
    runtime,
    openPath: previewHost.openPath,
    // Prefer the in-app overlay (<texra-diff-view> inside a wa-dialog).
    // Returning `false` when the IPC bridge is not yet wired (startup race)
    // or the BrowserWindow has been destroyed falls the host back to the
    // external-editor flow, so diffs never silently disappear.
    postToRenderer: (message) => {
      const ipc = ipcRef.current;
      if (!ipc || window.isDestroyed()) return false;
      ipc.postToRenderer(message);
      return true;
    },
  });
  /**
   * Await a host dialog the caller has already started, reporting rather than
   * raising its failure: a dialog that could not be shown must not fail the
   * run behind it. The caller still awaits the dialog, as it did before.
   */
  const awaitOrReport = (
    started: Effect.Effect<void, NotificationFailed>,
  ): Effect.Effect<void> =>
    started.pipe(
      Effect.catchTag('NotificationFailed', (error) =>
        Effect.sync(() => reportBackgroundError(error)),
      ),
    );
  const requestDiffHost = createDesktopDiffHost({
    runtime,
    openPath: requestPreviewHost.openPath,
    postToRenderer: postToRendererIfAlive,
  });
  /** The dialogs of one project's runs, each naming that project. */
  const agentRunHostFor = (
    project: string,
  ): Omit<DesktopAgentRunHost, 'openBuildDisplay' | 'openDiff'> => ({
    openPath: previewHost.openPath,
    confirmAcceptFile: (message) =>
      confirmDialog({ message, confirmLabel: 'Replace file', project }),
    chooseTeamAvailability: (unavailableNames) =>
      presentTeamAvailabilityPrompt(
        teamAvailabilityPrompt(unavailableNames),
        project,
      ),
    signInForRemoteAgentCatalog,
    // Presentation failures are reported, never raised: a run must not
    // fail because a dialog could not be shown. The caller still awaits the
    // dialog, as it did before.
    showInfoMessage: (message) =>
      awaitOrReport(showInfoMessage(message, project)),
    showWarningMessage: (message) => showWarningMessage(message, project),
    showErrorMessage: (message) =>
      awaitOrReport(showErrorMessage(message, project)),
    showErrorDialog: (message, docsCommand) =>
      awaitOrReport(showErrorDialog(message, docsCommand, project)),
    showInstructionDialog: (message, actions) =>
      awaitOrReport(showInstructionDialog(message, actions, project)),
    pickTranscriptExportFormat: () => pickTranscriptExportFormat(project),
  });
  const openFileDialog = async (dialogOptions: {
    title: string;
    defaultPath?: string;
    filters: Array<{ name: string; extensions: string[] }>;
    allowMultiple?: boolean;
  }) => {
    const result = await dialog.showOpenDialog(window, {
      title: dialogOptions.title,
      defaultPath: dialogOptions.defaultPath,
      filters: dialogOptions.filters,
      properties: dialogOptions.allowMultiple
        ? ['openFile', 'multiSelections']
        : ['openFile'],
    });
    return result.canceled ? undefined : result.filePaths;
  };
  /**
   * One binding per open project for this window (PRD 8.1, 12.2): the
   * session bridge the renderer subscribes to, the project's `host` snapshot,
   * and its presentation and launch path. Every open project is bound, not
   * only the shown one: the rail lists them all from their own views.
   */
  interface ProjectBinding {
    readonly project: DesktopProject;
    readonly bridge: SessionBridge;
    /** This window's port on the project's bridge. */
    readonly port: AttachedPort;
    readonly snapshot: ReturnType<typeof createHostSnapshotSource>;
    readonly run: ReturnType<typeof createDesktopAgentRun>;
    readonly workspace: ReturnType<typeof createDesktopWorkspaceIpc>;
    readonly browserViews: ReturnType<typeof createDesktopBrowserViews>;
    dispose(): void;
  }
  const projectBindings = new Map<string, ProjectBinding>();
  const bindProject = (project: DesktopProject): ProjectBinding => {
    const { workspace, browserViews } = createProjectWorkspace(project);
    const agentRunHost = agentRunHostFor(project.display.name);
    const files = createDesktopFileSelection({
      workspacePath: project.root,
      showOpenFileDialog: openFileDialog,
    });
    // Both diff hosts are built once per window, which shows several open
    // projects at once; each project's Review pane is addressed by its own
    // storage root, exactly as `openBuildDisplayIn` addresses its workbench.
    const projectDiffHost = desktopDiffHost.inProject(project.session.roots);
    const projectRequestDiffHost = requestDiffHost.inProject(
      project.session.roots,
    );
    // Install the recipient before host requests publish the recorder's state.
    const bridgeScope = Scope.makeUnsafe();
    const bridge = runtime.runSync(
      SessionBridge.make({
        session: project.session,
        handleHostRequest: (request, portId) =>
          hostRequests.handleHostRequest(request, portId),
        onPortClosed: (portId) => hostRequests.closePort(portId),
      }).pipe(
        Effect.tap(() =>
          Effect.forkScoped(workspace.followFilesWritten, {
            startImmediately: true,
          }),
        ),
        Scope.provide(bridgeScope),
      ),
    );
    const snapshot = createHostSnapshotSource({
      project: project.display,
      root: project.root,
      stores: project.session.roots,
      secrets: options.secrets,
      fileOptions: () =>
        files.fileOptions().pipe(
          Effect.mapError(
            (cause) =>
              new HostSnapshotReadFailed({
                member: 'fileOptions',
                message: 'The project file lists could not be read.',
                cause,
              }),
          ),
        ),
      onError: reportBackgroundError,
      publish: (next) => bridge.setHost(next),
    });
    const funnel = onboardingIpcRef.current?.funnelState();
    const initialSnapshot = funnel
      ? snapshot.setOnboarding(funnel).pipe(Effect.andThen(snapshot.refresh))
      : snapshot.refresh;
    const run = createDesktopAgentRun({
      runtime,
      host: {
        ...agentRunHost,
        openDiff: projectDiffHost.openDiff,
        openBuildDisplay: previewHost.openBuildDisplayIn(project.session.roots),
      },
      toolEditPreview: {
        openPath: requestPreviewHost.openPath,
        openBuildDisplay: requestPreviewHost.openBuildDisplayIn(
          project.session.roots,
        ),
        openDiff: projectRequestDiffHost.openDiff,
        closeDiff: projectRequestDiffHost.closeDiff,
      },
      session: project.session,
      showAgentConfigBanner: ({ agentName, category }) =>
        withProcessServices(
          runtime,
          snapshot.showAgentConfigBanner(agentName, category),
        ),
      // A resolved agent also retires the missing-agent warning.
      onLaunched: (runId) => {
        bridge.surfaceAction({ kind: 'select', runId });
        runtime.runFork(snapshot.clearAgentConfigBanner);
      },
      // Recompute the onboarding funnel when a launch settles so a first
      // successful run leaves the setup card without a restart. The settled
      // launch includes AgentRunLifecycle's firstRunDone write.
      onRunCompleted: refreshFunnelAfterLaunch,
    });
    const hostRequests = createDesktopHostRequests({
      runtime,
      session: project.session,
      secrets: options.secrets,
      draftRequests: hostDraftRequests,
      host: {
        ...agentRunHost,
        openPath: requestPreviewHost.openPath,
        openBuildDisplay: requestPreviewHost.openBuildDisplayIn(
          project.session.roots,
        ),
        openDiff: projectRequestDiffHost.openDiff,
      },
      run,
      files,
      snapshot,
      workspacePath: project.root,
      resourcesPath: options.resourcesPath,
      postToRenderer: postToRendererIfAlive,
      postSurfaceAction: (action) => bridge.surfaceAction(action),
      getCustomAgentDirectory,
      showFirstRunWalkthrough: () => shellActions.showFirstRunWalkthrough(),
      onboarding: requireOnboardingIpc(),
      openExternalUrl: requestPreviewHost.openExternal,
      recheckTools: () =>
        refreshToolAvailability({
          workspaceRoot: project.roots.workspace,
          config: project.roots.config,
        }),
    });
    const port = runtime.runSync(
      bridge.attach({
        id: `window:${window.id}`,
        send: (message) => {
          postToRendererIfAlive(message);
        },
      }),
    );
    void runtime.runPromise(initialSnapshot);
    return {
      project,
      bridge,
      port,
      snapshot,
      run,
      workspace,
      browserViews,
      dispose() {
        workspace.disposeRendererResources();
        // The port before the bridge, as the extension's `dispose` does.
        // The port's release (its map entry, its transcript set,
        // `onPortClosed`) is synchronous by construction and runs inside
        // this fork before it returns, so `hostRequests.dispose()` below
        // still follows it as it did under `bridge.dispose()`; only the
        // framer's interruption and the drain of a request in flight (in
        // the bridge scope, uninterruptible) finish later, and neither
        // reaches a disposed host: the answer of a gone port is dropped.
        runtime.runFork(port.close);
        runtime.runFork(Scope.close(bridgeScope, Exit.void));
        hostRequests.dispose();
        run.dispose();
      },
    };
  };
  const syncProjectBindings = () => {
    const open = new Map(
      [options.projects.fallback(), ...options.projects.list()].map(
        (project) => [project.key, project] as const,
      ),
    );
    for (const [key, binding] of projectBindings) {
      if (open.has(key)) continue;
      projectBindings.delete(key);
      binding.dispose();
    }
    for (const [key, project] of open) {
      if (projectBindings.has(key)) continue;
      projectBindings.set(key, bindProject(project));
    }
  };
  windowResources.add(() => {
    for (const binding of projectBindings.values()) {
      binding.dispose();
    }
    projectBindings.clear();
  });
  const activeBinding = () => projectBindings.get(activeProject().key);
  const requireOnboardingIpc = (): DesktopOnboardingIpc => {
    const onboarding = onboardingIpcRef.current;
    if (!onboarding) throw new Error('Desktop onboarding IPC is not attached.');
    return onboarding;
  };
  // Catalog refresh leaves each Surface's selections intact. Applying an
  // agent mode separately sends the chosen root to that project's launcher.
  // Each project's catalogs answer for that project: its snapshot source was
  // built over its own roots, so the presets come from that project's
  // workspace state, not the caller's.
  const refreshCatalogs = () =>
    Effect.forEach(
      [...projectBindings.values()],
      (binding) => binding.snapshot.refreshCatalogs,
      { concurrency: 'unbounded', discard: true },
    );
  const settingsUi: DesktopSettingsUiHost = {
    showInfoMessage,
    showErrorMessage,
    confirmAction: (message, confirmLabel) =>
      confirmDialog({ message, confirmLabel }),
    openPath: previewHost.openPath,
    // Selection is the surface's: a settings jump asks the shown project's
    // surface to select the run, and reports a run the view no longer holds
    // as missing. The settings wire carries the id as a plain string, so it
    // is parsed here, at the view boundary: a string that is not a run id
    // names no run the view could hold.
    revealRun: async (rawRunId) => {
      const binding = activeBinding();
      if (!binding) return 'unavailable';
      const runId = RunIdSchema.safeParse(rawRunId);
      if (!runId.success) return 'missing';
      const view = SubscriptionRef.getUnsafe(binding.project.session.view);
      if (!view.runs.has(runId.data)) return 'missing';
      binding.bridge.surfaceAction({ kind: 'select', runId: runId.data });
      return 'revealed';
    },
    getRunLabel: (rawRunId) => {
      const runId = RunIdSchema.safeParse(rawRunId);
      if (!runId.success) return undefined;
      return SubscriptionRef.getUnsafe(activeProject().session.view).runs.get(
        runId.data,
      )?.label;
    },
    promptForSecret: (input) =>
      promptController.request({ ...input, password: true }),
    onError: reportAsyncError,
  };
  const requireSettingsIpc = (): DesktopSettingsIpc => {
    const settingsIpc = settingsIpcRef.current;
    if (!settingsIpc) throw new Error('Desktop settings IPC is not attached.');
    return settingsIpc;
  };
  const postProjects = () => {
    const { projects, activeKey } = SubscriptionRef.getUnsafe(
      options.projects.state,
    );
    postToRendererIfAlive({
      command: DESKTOP_PROJECT_COMMANDS.PROJECTS,
      open: projects.flatMap(({ key, root }) =>
        root === undefined ? [] : [key],
      ),
      activeKey,
    });
  };
  /**
   * Bind the window to the project it shows: settings controllers, settings
   * surface and title; the session bridge and workbench stay with their project.
   * The old settings IPC is detached first, so an attach that throws partway
   * leaves settings messages unhandled, not routed to a closed project's IPC.
   */
  const attachActiveProject = (documentChanged = false) => {
    const project = activeProject();
    if (project === attachedProject && !documentChanged) return;
    const documentBinding = projectBindings.get(project.key);
    const previousScope = projectScope;
    attachedProject = project;
    const owner = Scope.makeUnsafe();
    projectScope = owner;
    const postForActiveProject = (message: unknown) => {
      if (projectScope !== owner) return false;
      return postToRendererIfAlive(message);
    };
    settingsIpcRef.current = undefined;
    if (previousScope) runtime.runFork(Scope.close(previousScope, Exit.void));
    const agentSettingsController = new DefaultDesktopAgentSettingsController({
      roster: createWorkspaceAgentRosterController({
        workspaceState: project.roots.workspaceState,
        globalState: options.globalState,
      }),
      workspaceState: project.roots.workspaceState,
      globalState: options.globalState,
      registry: {
        loadAgents,
        refreshAgents: refresh,
        getAgents: getAgentsByCategory,
      },
      directory: {
        getCustomAgentDirectory: () => options.agentDirectories.custom(),
        getSourceDirectory: (source: AgentSource) =>
          agentSourceDirectory(options.agentDirectories, source),
        selectCustomAgentDirectory: async () => {
          const result = await dialog.showOpenDialog(window, {
            title: 'Select Custom Agents Folder',
            defaultPath: folderPickerDefaultPath(),
            properties: ['openDirectory', 'createDirectory'],
          });
          return result.canceled ? undefined : result.filePaths[0];
        },
        openPath: previewHost.openPath,
        revealPath: async (filePath) => shell.showItemInFolder(filePath),
      },
      renderer: {
        postToRenderer: postForActiveProject,
      },
      prompts: {
        promptText: (input) => promptController.request(input),
        confirm: ({ title, message }) =>
          confirmDialog({ title, message, confirmLabel: 'Continue' }),
        chooseTeamAvailability: presentTeamAvailabilityPrompt,
      },
      remoteCatalog: {
        canAccess: () => options.supabaseAuth.authenticated,
        signIn: signInForRemoteAgentCatalog,
      },
      notifications: { showInfoMessage, showErrorMessage },
      resourcesPath: options.resourcesPath,
      onCatalogChanged: (selectedToolUseAgent) =>
        Effect.gen(function* () {
          yield* refreshCatalogs();
          if (!selectedToolUseAgent) return;
          const binding = projectBindings.get(project.key);
          if (!binding || binding !== documentBinding) return;
          binding.bridge.surfaceAction({
            kind: 'launch',
            patch: { sessionType: 'toolUse', agent: selectedToolUseAgent },
          });
        }),
    });
    const credentialSettingsController =
      new DefaultDesktopCredentialSettingsController({
        runtime,
        stores: project.roots,
        workspaceState: project.roots.workspaceState,
        globalState: options.globalState,
        config: project.roots.config,
        secrets: options.secrets,
        renderer: {
          postToRenderer: postForActiveProject,
        },
        // The window's dialogs behind the host-neutral prompt port. The
        // renderer overlay settles a prompt it could not deliver as "no
        // answer", so `input` has no failure of its own; the native dialogs
        // reject once the window they anchor to is gone. `info` is the
        // notification member with an answer nobody reads, so it is that
        // program and its tag, not a re-wording of it.
        prompt: {
          input: (input) =>
            promptController.request({
              title: input.prompt ?? 'Set API key',
              prompt: input.prompt ?? 'Enter API key',
              password: input.password,
            }),
          confirm: (message, promptOptions) =>
            confirmDialog({
              message,
              detail: promptOptions?.detail,
              confirmLabel: promptOptions?.confirmLabel,
            }),
          info: (message) =>
            showInfoMessage(message).pipe(Effect.map(() => undefined)),
        },
        externalOpener: {
          // The sign-in variant is the same program with the window's own
          // "could not open" dialog suppressed — the sign-in flow reports a
          // missing browser itself and falls back to a device code.
          openExternal: (url) => openExternalProgram(url, true),
          openSubscriptionSignInUrl: (url) => openExternalProgram(url, false),
          ...desktopSignInPresenters(window, previewHost.openExternal),
        },
        notifications: {
          showInfoMessage,
          showWarningMessage,
          showErrorMessage,
        },
        auth: {
          signIn,
          signOut: () => desktopAuth.signOut(),
        },
        onCredentialChanged: () =>
          onboardingIpcRef.current?.refreshOnboardingFunnel() ?? Effect.void,
        onModelOptionsChanged: refreshCatalogs,
        // Credential operations already show their specific failure dialog. Keep
        // the shared callback log-only so one failure never opens a second,
        // generic desktop-operation dialog.
        onError: reportBackgroundError,
      });
    const toolingSettingsController =
      new DefaultDesktopToolingSettingsController({
        onError: reportAsyncError,
        globalState: options.globalState,
        config: project.roots.config,
        workspaceRoot: project.roots.workspace,
        runtime,
        renderer: {
          postToRenderer: postForActiveProject,
        },
        commands: {
          run: async (command: string) => {
            if (projectBindings.get(project.key) !== documentBinding) return;
            postToRendererIfAlive({
              command: DESKTOP_WORKSPACE_COMMANDS.TERMINAL_OPEN_COMMAND,
              session: project.key,
              initialCommand: command,
            });
          },
        },
        latexToolingController: new LatexToolingController({
          checkToolInstalled: (tool) => checkToolInstalled(tool, false),
          findPath: findToolInCommonPaths,
          detectPackageManager,
          getPlatform: () => normalizePlatform(process.platform),
          // Extension hosting is deliberately unavailable in TeXRA Desktop.
          isLatexWorkshopInstalled: () => false,
          getRecommendedStatus: () => ({
            outDir: true,
            autoRevealExclude: true,
          }),
          onDetectionError: reportBackgroundError,
        }),
      });
    settingsIpcRef.current = runtime.runSync(
      createDesktopSettingsIpc({
        postToRenderer: postForActiveProject,
        agentSettingsController,
        credentialSettingsController,
        toolingSettingsController,
        globalState: options.globalState,
        secrets: options.secrets,
        // The one browser hand-off every settings URL takes. Its failure
        // reaches the settings IPC's own report, so the opener shows no dialog
        // of its own: one failed open, one dialog.
        externalOpener: {
          openExternal: (url) => openExternalProgram(url, false),
        },
        ui: settingsUi,
        session: project.session,
        runtime,
      }).pipe(
        // Gated on the same owner check as `postForActiveProject`: the old
        // scope's close is forked, so the switch itself must stop the old
        // title synchronously.
        Effect.tap(() =>
          installDesktopWindowTitle(
            window,
            project.session,
            project.root && project.display.name,
            () => projectScope === owner,
          ),
        ),
        Scope.provide(owner),
      ),
    );
  };
  /**
   * Follow the registry: bind a project that opened, release one that
   * closed, and move the window's project-bound surfaces (settings, title)
   * and the onboarding funnel, whose credential check reads the shown
   * project's config, to the project it now shows.
   */
  let menuRecent: readonly string[] | undefined;
  const installMenu = (recent: readonly string[]) => {
    if (recent === menuRecent) return;
    menuRecent = recent;
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildDesktopMenuTemplate(shellActions, {
          roots: recent,
          open: (root) =>
            runtime.runFork(
              openProjectAt(root).pipe(
                Effect.catch((error) =>
                  Effect.sync(() => reportAsyncError(error)),
                ),
              ),
            ),
          clear: () =>
            runtime.runFork(
              options.projects
                .clearRecent()
                .pipe(
                  Effect.catch((error) =>
                    Effect.sync(() => reportAsyncError(error)),
                  ),
                ),
            ),
        }),
      ),
    );
  };
  const followProjects = (state: DesktopProjectsState) => {
    syncProjectBindings();
    installMenu(state.recent);
    const switched = state.activeKey !== attachedProject?.key;
    if (switched) {
      for (const binding of projectBindings.values())
        binding.browserViews.hideAll();
    }
    attachActiveProject();
    postProjects();
    if (switched) runtime.runFork(refreshFunnelAfterLaunch);
  };
  const onboardingIpc = createDesktopOnboardingIpc(
    { postToRenderer: postToRendererIfAlive },
    {
      state: options.globalState,
      // Single source of truth for "does the user have a usable credential",
      // shared by every host (extension, desktop, CLI) so this credential-gating
      // logic can't drift between them.
      hasCredential: () =>
        hasUsableSetupCredential(
          activeProject().session.roots,
          options.secrets,
        ).pipe(withLogChannel('Setup Credentials')),
      // Launch the setup conversation when the user clicks "Run Setup" on the
      // setup card, mirroring the extension's `launchSetupAssistant` →
      // launch path: resolve a model the user's credentials can call,
      // build the setup execute message, and run it through the same desktop
      // execute path the renderer's Execute button uses. The per-session
      // `setupKickoffStarted` dedup guard inside the onboarding IPC keeps this
      // one-shot; on a resolution failure it throws so that guard resets and a
      // later "Run Setup" click can retry.
      kickoffSetup: () =>
        Effect.gen(function* () {
          const setupSession = activeProject().session;
          // The project the user started setup in, taken before the first
          // suspension: the run and its presentation belong to it even when
          // the window moves to another project while the model resolves and
          // agents load.
          const binding = activeBinding();
          // The window's services, so the model resolution, the agent load and
          // the launch below are one program on this runtime's context rather
          // than three nested runs behind a promise.
          const context = yield* runtime.contextEffect;
          yield* Effect.gen(function* () {
            if (!binding) {
              return yield* Effect.fail(
                new Error('Open a folder before running setup.'),
              );
            }
            const { buildDesktopSetupRunRequest } = yield* Effect.tryPromise({
              try: () => import('@controllers/onboarding/setupLaunch'),
              catch: ensureError,
            });
            const request = yield* buildDesktopSetupRunRequest(
              setupSession.roots,
              options.secrets,
            );
            if (!request) {
              return yield* Effect.fail(
                new Error(
                  'No model is available for your current credentials. Sign in with ChatGPT or add a provider or coding-plan API key in Models, then try setup again.',
                ),
              );
            }
            // Idempotent: joins the in-flight/initialized registry so a kickoff
            // racing the startup `loadAgents()` cannot hit "Could not find agent:
            // setup" (mirrors `setupAssistantCommand.launchSetupAssistant`).
            yield* loadAgents();
            yield* binding.run.runValidated(request);
          }).pipe(
            Effect.provideContext(context),
            // Setup continues after its initiating request has completed, so
            // the failure is presented here and the kickoff settles.
            Effect.catch((error) => {
              if (error instanceof Cancelled) return Effect.void;
              const primaryError = primaryAgentError(error);
              return presentAgentFailure(
                setupSession.interactions,
                {
                  kind: classifyAgentError(primaryError),
                  message:
                    primaryError instanceof Rejected
                      ? primaryError.reason
                      : toErrorMessage(primaryError),
                },
                { replayWhenAttached: true },
              );
            }),
          );
        }),
      // Suspended so the "settings IPC not attached" guard raises when the
      // card's program runs, not when the port is built.
      signInWithChatGpt: () =>
        Effect.suspend(() => requireSettingsIpc().signInChatGpt()),
    },
  );
  onboardingIpcRef.current = onboardingIpc;
  afterLaunchFunnelRefresh.current = refreshFunnelAfterLaunch;
  // The funnel is host state every open project's snapshot carries (8.1).
  windowResources.add(
    onboardingIpc.onFunnelChange((state) =>
      Effect.forEach(
        [...projectBindings.values()],
        (binding) => binding.snapshot.setOnboarding(state),
        { discard: true },
      ),
    ),
  );
  runtime.runFork(
    onboardingIpc.refreshOnboardingFunnel().pipe(
      // Keep this handler exhaustive over funnel reads and writes.
      Effect.catch((cause: StateWriteFailed | StateReadFailed) =>
        Effect.sync(() =>
          reportAsyncError(
            new OnboardingRefreshFailed({
              message: `The onboarding state could not be refreshed: ${toErrorMessage(cause)}`,
              cause,
            }),
          ),
        ),
      ),
    ),
  );
  const shellActions = createDesktopShellActions(
    { postToRenderer: postToRendererIfAlive },
    {
      getCustomAgentDirectory,
      openExternalUrl: previewHost.openExternal,
      openLogFolder: () => previewHost.openPath(getDesktopLogDirectory()),
      openPath: previewHost.openPath,
      openWorkspaceFolder,
      signIn,
      showInfoMessage,
      showLauncher: () => {
        if (!attachedProject) return;
        projectBindings
          .get(attachedProject.key)
          ?.bridge.surfaceAction({ kind: 'selectNew' });
      },
      onAsyncError: reportAsyncError,
      runtime,
    },
  );
  /** Each document/project owns one auxiliary transport and its resources.
   *  Callbacks capture the project before any asynchronous file or PTY work. */
  function createProjectWorkspace(project: DesktopProject) {
    const post = (message: unknown) => {
      if (projectBindings.get(project.key)?.workspace !== workspace)
        return false;
      return postToRendererIfAlive({
        ...(message as Record<string, unknown>),
        session: project.key,
      });
    };
    const ptyHost = createDesktopPtyHost({
      cwd: () => project.root,
      onData: (sessionId, data) =>
        post({
          command: DESKTOP_WORKSPACE_COMMANDS.TERMINAL_DATA,
          sessionId,
          data,
        }),
      onExit: (sessionId, exitCode) =>
        post({
          command: DESKTOP_WORKSPACE_COMMANDS.TERMINAL_EXIT,
          sessionId,
          exitCode,
        }),
      onError: reportBackgroundError,
    });
    const browserViews = createDesktopBrowserViews({
      getWindow: () => (window.isDestroyed() ? undefined : window),
      // Electron's window-open handler is the caller here, so the hand-off
      // runs at this arm rather than reaching the view as a program.
      openExternalUrl: (url) =>
        runtime.runPromise(previewHost.openExternal(url)),
      onNavigated: (state) =>
        post({ command: DESKTOP_WORKSPACE_COMMANDS.BROWSER_STATE, ...state }),
      onError: reportAsyncError,
      onBlockedExternalUrl: reportBackgroundError,
      onExternalOpenError: reportBackgroundError,
    });
    const workspace = createDesktopWorkspaceIpc(
      { postToRenderer: post },
      {
        ptyHost,
        browserViews,
        toWindowBounds: (bounds) => {
          const zoom = window.isDestroyed()
            ? 1
            : window.webContents.getZoomFactor();
          return {
            x: Math.round(bounds.x * zoom),
            y: Math.round(bounds.y * zoom),
            width: Math.round(bounds.width * zoom),
            height: Math.round(bounds.height * zoom),
          };
        },
        getWorkspacePath: () => project.root,
      },
    );
    return { workspace, browserViews };
  }
  const workspaceIpc = {
    handleMessage(
      message: Parameters<DesktopMessageHandler['handleMessage']>[0],
    ) {
      const parsed = DesktopWorkspaceInboundMessageSchema.safeParse(message);
      if (!parsed.success) return undefined;
      const binding = projectBindings.get(parsed.data.session);
      if (!binding) {
        return Effect.sync(() =>
          console.warn(
            `Dropped a workspace request for closed project ${parsed.data.session}`,
          ),
        );
      }
      // Hidden projects retain their resources, but cannot cover the visible project
      // with a late browser-bounds notification.
      if (
        parsed.data.command === DESKTOP_WORKSPACE_COMMANDS.BROWSER_BOUNDS &&
        binding.project !== activeProject()
      )
        return Effect.void;
      return binding.workspace.handleMessage(message);
    },
    disposeRendererResources() {
      // Navigation destroys the document, including its request correlations
      // and recording ownership. Replace its ports while retaining sessions.
      for (const binding of projectBindings.values()) {
        binding.dispose();
      }
      projectBindings.clear();
      syncProjectBindings();
      attachActiveProject(true);
    },
  };
  // The renderer owns editor dirtiness. This event is the main process's only
  // reading of it: Chromium emits it after the renderer's beforeunload handler
  // observes a dirty Monaco buffer and refuses the unload, so every close path
  // (quit, document reload, window close) asks here and nowhere else.
  bootstrapDesktopWindowLifecycle({
    webContents: window.webContents,
    workspaceIpc,
    showDiscardDialog,
    isFatalShutdownRequested: isFatalDesktopShutdownRequested,
    clearContinueQuitAfterWindowClose: () => {
      continueQuitAfterWindowClose = undefined;
    },
  });
  const logsIpc = createDesktopLogIpc(
    { postToRenderer: postToRendererIfAlive },
    {
      readLog: () =>
        readDesktopLogSnapshot({ workspacePath: activeProject().root }),
      copyLog: (text) => clipboard.writeText(text),
      showSaveDialog: (dialogOptions) =>
        dialog.showSaveDialog(window, dialogOptions),
    },
  );
  // One handler per inbound command namespace: the message's `command` names
  // its route (`desktopInboundRoute`), so a message is parsed by the one
  // surface that owns it instead of being offered to every handler in turn.
  const desktopRoutes: Record<DesktopInboundRoute, DesktopMessageHandler> = {
    prompt: promptController,
    settings: {
      handleMessage: (message) =>
        settingsIpcRef.current?.handleMessage(message),
    },
    onboarding: onboardingIpc,
    projects: createDesktopProjectsIpc({
      postProjects,
      selectProject,
      closeProject,
    }),
    workspace: workspaceIpc,
    logs: logsIpc,
    shell: createDesktopShellIpc(shellActions),
  };
  const hostBridge = installDesktopHostBridge(window, {
    onRendererMessage: (message) => {
      if (isDesktopCommandMessage(message)) {
        const route = desktopInboundRoute(message.command);
        // A command no surface owns is renderer drift, not a session
        // message: session frames are keyed by `kind`, never `command`.
        const program = route && desktopRoutes[route].handleMessage(message);
        // The one run site for every namespace's program, and its one report:
        // a failure or defect reaches the window's async-error reporter.
        if (program)
          runtime.runFork(
            program.pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.sync(() => reportAsyncError(Cause.squash(cause))),
              ),
            ),
          );
        return;
      }
      // A session message names its project: that project's port answers it.
      const addressed = SessionMessageEnvelopeSchema.safeParse(message);
      if (!addressed.success) return;
      const binding = projectBindings.get(addressed.data.session);
      if (!binding) {
        console.warn(
          `Dropped a renderer message for session ${addressed.data.session}: not open`,
        );
        return;
      }
      runtime.runFork(binding.port.receive(message));
    },
  });
  windowResources.add(() => {
    promptController.dispose();
    hostBridge.dispose();
  });
  ipcRef.current = { postToRenderer: hostBridge.postToRenderer };
  syncProjectBindings();
  attachActiveProject();
  // Subscribed last: the first change it sees may bind a project, which
  // needs every window surface above. Its first element is the state just
  // attached, so it changes nothing.
  const followScope = Scope.makeUnsafe();
  windowResources.add(() => {
    runtime.runFork(Scope.close(followScope, Exit.void));
  });
  runtime.runFork(
    Stream.runForEach(
      SubscriptionRef.changes(options.projects.state),
      (state) =>
        Effect.try({
          try: () => followProjects(state),
          catch: ensureError,
        }).pipe(
          Effect.catch((error) => Effect.sync(() => reportAsyncError(error))),
        ),
    ).pipe(Effect.forkIn(followScope)),
  );
  installMenu(SubscriptionRef.getUnsafe(options.projects.state).recent);
  window.once('closed', () => {
    const continueQuit = continueQuitAfterWindowClose;
    continueQuitAfterWindowClose = undefined;
    runtime.runSync(
      Effect.try({
        try: () => windowResources.dispose(),
        catch: ensureError,
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => reportBackgroundError(error)),
        ),
      ),
    );
    if (mainWindow === window) {
      mainWindow = null;
      if (process.platform === 'darwin') {
        Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }]));
      }
    }
    // Resume the quit once Electron has finished closing this window. A quit
    // requested from inside `closed` lands before the window leaves the
    // window list, so Electron abandons it and emits `window-all-closed`
    // instead of `will-quit`, which on macOS leaves the process running.
    if (continueQuit) setImmediate(continueQuit);
  });
  let windowPresented = false;
  const presentWindow = (): void => {
    if (windowPresented || window.isDestroyed()) return;
    windowPresented = true;
    window.center();
    window.show();
    if (process.platform === 'darwin') app.focus({ steal: true });
    window.focus();
  };
  window.once('ready-to-show', presentWindow);
  window.webContents.once('did-finish-load', () => {
    // `ready-to-show` is not guaranteed when the page is already cached, so
    // keep load completion as an idempotent presentation fallback.
    presentWindow();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
    return;
  }

  void window.loadFile(join(options.mainDir, '../renderer/index.html'));
}

if (protocolLifecycle.ownsSingleInstanceLock) {
  // The desktop entry: one program from Electron's `whenReady` to the wired
  // window. Its fatal report is the one fold, and it runs on the default
  // runner because it is what builds the process runtime.
  void Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => app.whenReady(),
        catch: ensureError,
      });
      // Opened by the startup program below; a startup that fails before it
      // runs the shutdown handlers that read it.
      let projects: DesktopProjectRegistry | undefined;
      // Read through thunks: the resume owner is the port that
      // `initializeElectronPlatform` installs, so it exists before either.
      const processResumeOwner = new DesktopProcessResumeOwner({
        sessions: () =>
          (projects ? [projects.fallback(), ...projects.list()] : []).map(
            (p) => p.session,
          ),
        runtime: () => runtime,
        onLaunchSettled: Effect.suspend(
          () => afterLaunchFunnelRefresh.current ?? Effect.void,
        ),
      });
      // The shutdown handlers, the startup program, and every surface they
      // wire run on the process runtime the platform builds.
      const { lifecycle, runtime, processScope, initialize } =
        yield* initializeElectronPlatform(moduleDirname, processResumeOwner);
      registerRuntimeShutdownHandlers(lifecycle, {
        beforeAgentShutdown: [Effect.sync(() => processResumeOwner.disable())],
        afterAgentShutdown: [killActiveRecording()],
        // Agent shutdown runs first so its final events enter the
        // process-owned stores. Flush in BEFORE so persistence cannot be
        // delayed by a later ON-phase language-service disposal.
        flushArtifacts: Effect.suspend(
          () => projects?.flushArtifacts() ?? Effect.void,
        ),
        // The external-editor patch directories recorded by every window's
        // diff host are removed here, once, while the process is still alive.
        afterFlushArtifacts: [
          withProcessServices(runtime, removeExternalDiffPatchDirs),
        ],
        // Every project's session, most recently opened first, released
        // before the runtime they run on goes (or, before the registry
        // opened, the fallback project's scope it would own).
        releaseSessions: Effect.suspend(
          () => projects?.dispose() ?? Scope.close(processScope, Exit.void),
        ),
        disposeRuntime: disposeProcessRuntime(runtime),
      });

      // Until the initial window is fully wired, any startup failure (platform
      // init included) runs the shutdown an ordinary application exit does.
      // Once this program completes, the lifecycle owns that cleanup. The
      // original failure is re-raised, not wrapped: the fatal report below
      // prints `error.stack` from the `Cause.squash`'d error.
      yield* withProcessServices(
        runtime,
        Effect.gen(function* () {
          const platformInit = yield* initialize;
          const projectRecords = yield* openDesktopProjectRecords;
          // Reopen every folder left open last time and show the one shown
          // last. A folder that is gone or no longer opens is reported once the
          // window exists; the others open regardless. Read before the
          // registry opens, so the recent list it starts from is pruned too.
          const remembered = yield* readRememberedDesktopProjects().pipe(
            Effect.provideService(DesktopProjectRecords, projectRecords),
          );
          const registry = yield* openDesktopProjectRegistry({
            dataRoot: platformInit.dataRoot,
            processRoots: platformInit.processRoots,
            processScope,
            globalConfigStore: platformInit.globalConfigStore,
            stores: {
              ...platformInit.processRoots,
              secrets: platformInit.secrets,
            },
          }).pipe(Effect.provideService(DesktopProjectRecords, projectRecords));
          projects = registry;
          const unopenedProjects = remembered.missing.map(
            (root) => `${root} (no such folder; forgotten)`,
          );
          yield* Effect.forEach(
            remembered.roots,
            (root) =>
              registry.open(root).pipe(
                Effect.catch((error) =>
                  Effect.sync(() => {
                    unopenedProjects.push(`${root}: ${toErrorMessage(error)}`);
                  }),
                ),
              ),
            { discard: true },
          );
          yield* registry.activate(registry.list().at(-1)?.root);
          yield* Effect.sync(() => {
            // Ask the renderer to close before draining process services. A dirty
            // editor can veto that close and remain fully operational. Once the
            // window really closes, its handler calls app.quit() again and this
            // listener proceeds with the ordinary shutdown chain.
            installDesktopBeforeQuitWiring({
              app,
              getMainWindow: () => mainWindow,
              lifecycle,
              continueAfterWindowClose: (continueQuit) => {
                continueQuitAfterWindowClose = continueQuit;
              },
            });

            const pendingOAuthStore = createDesktopPendingOAuthStore(
              platformInit.globalState,
            );
            installContentSecurityPolicy();
            reopenMainWindow = () =>
              createWindow({
                projects: registry,
                supabaseAuth: platformInit.supabaseAuth,
                pendingOAuthStore,
                globalState: platformInit.globalState,
                secrets: platformInit.secrets,
                agentDirectories: platformInit.agentDirectories,
                resourcesPath: platformInit.resourcesPath,
                mainDir: platformInit.mainDir,
                runtime,
                setupAuth: platformInit.setupAuth,
              });
            reopenMainWindow();
            app.on('activate', () => {
              if (BrowserWindow.getAllWindows().length === 0)
                reopenMainWindow?.();
            });
          });
          // For the process lifetime: the fallback project's scope is the
          // last the shutdown releases.
          yield* followDesktopAttention.pipe(
            Effect.provideService(DesktopProjects, registry),
            Effect.provideService(
              DesktopAttentionPort,
              electronAttentionPort({
                window: () => mainWindow,
                reveal: (key, runId) => {
                  focusOrReopenMainWindow();
                  revealProjectRun.current?.(key, runId);
                },
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning(
                'The dock badge and notifications stopped following the projects',
                cause,
              ),
            ),
            Effect.forkIn(processScope),
          );
          if (unopenedProjects.length > 0) {
            // Detached: startup does not wait on the user dismissing it.
            yield* Effect.tryPromise({
              try: () =>
                showDesktopWarningDialog(
                  `Some projects could not be reopened:\n${unopenedProjects.join('\n')}`,
                ),
              catch: (cause) =>
                new NotificationFailed({
                  member: 'showWarningMessage',
                  message: 'The unopened-projects warning could not be shown.',
                  cause,
                }),
            }).pipe(
              // Its failure or a defect: detached, nothing else reports it.
              Effect.catchCause((cause) =>
                Effect.sync(() => console.error(Cause.squash(cause))),
              ),
              Effect.forkDetach,
            );
          }
        }),
      ).pipe(Effect.onError(() => lifecycle.runShutdown));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => reportFatalStartupError(Cause.squash(cause))),
      ),
    ),
  );
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
