import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
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
import PQueue from 'p-queue';

import { Cause, Effect, Exit, SubscriptionRef } from 'effect';
import { z } from 'zod';
import { runInSession } from '@agent/runtime';
import {
  computeAgentOptionsData,
  getAgentsByCategory,
  getVisibleAgents,
  loadAgents,
  refresh,
} from '@agent/index';
import { SupabaseClient } from '@auth/SupabaseClient';
import { hostPort } from '@common/hostPort';
import {
  agentErrorPresentation,
  classifyAgentError,
  primaryAgentError,
} from '@common/errors/agentErrorClassification';
import {
  teamAvailabilityPrompt,
  type TeamAvailabilityPrompt,
} from '@common/teams/TeamPlan';
import { LatexToolingController } from '@controllers/settingsView/LatexToolingController';
import { prepareMainViewExecutionLaunch } from '@controllers/mainView/backend/MainViewExecutionLaunchController';
import { SubscriptionUsageService } from '@controllers/modelAccess/subscriptionUsage/SubscriptionUsageService';
import {
  SessionBridge,
  type AttachedPort,
} from '@controllers/session/SessionBridge';
import { createHostSnapshotSource } from '@controllers/session/hostSnapshotSource';
import { HostDraftRequests } from '@controllers/session/hostDraftRequests';
import { disposeProcessRuntime } from '@controllers/session/sessionLayer';
import { createLog } from '@logger/logUtils';
import { hasUsableSetupCredential } from '@model/setupCredentialAccess';
import { DisposableStore } from '@platform/disposable';
import type { AgentDirectoriesPort, StateStore } from '@platform/interfaces';
import { effectRuntime } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import {
  INSTRUCTION_ACTION,
  type AgentSource,
  type InstructionAction,
} from '@shared/schemas';
import { normalizePlatform } from '@shared/constants/latexToolchain';
import { projectDisplayOf } from '@shared/session/hostSnapshot';
import { Cancelled, Rejected } from '@shared/session/requestErrors';
import { registerRuntimeShutdownHandlers } from '@tools/agentCliSessionStores';
import {
  getLastCheckResults,
  refreshToolAvailability,
} from '@tools/toolAvailability';
import { killActiveRecording } from '@tools/media/audio';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  readGitEnvironmentSummary,
  readRecentCommits,
} from '@utils/git/repositoryOverview';
import { BinaryResolver } from '@utils/system/binaryResolver';
import {
  checkToolInstalled,
  detectPackageManager,
} from '@utils/system/toolUtils';
import { openDesktopProjectRecords } from './desktopProjectRecords.js';
import { DesktopProcessResumeOwner } from './desktopAgentResume.js';
import { createDesktopDiffHost } from './desktopDiffHost.js';
import { createDesktopFileSelection } from './desktopFileSelection.js';
import { createDesktopHostRequests } from './desktopHostRequests.js';
import { createDesktopAgentExecution } from './desktopAgentExecution.js';
import { installDesktopHostBridge } from './hostBridge.js';
import { createDesktopLogIpc } from './desktopLogIpc.js';
import {
  isDesktopCommandMessage,
  type DesktopMessageHandler,
} from './desktopIpcTypes.js';
import {
  openDesktopProjectRegistry,
  readRememberedDesktopProjects,
  type DesktopProject,
  type DesktopProjectRegistry,
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
  EMPTY_DESKTOP_ENVIRONMENT_SUMMARY,
} from '../shared/desktopWorkspaceMessages.js';
import {
  DESKTOP_PROJECT_COMMANDS,
  DesktopCloseProjectMessageSchema,
  DesktopSelectProjectMessageSchema,
} from '../shared/desktopProjectMessages.js';
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
  initializeDesktopSetupAuth,
  registerDesktopSetupSignIn,
} from './desktopSetupAuth.js';
import {
  checkForDesktopUpdate,
  DESKTOP_RELEASES_PAGE_URL,
} from './desktopUpdateChecker.js';
import {
  createDesktopAuthCallbackState,
  createDesktopAuthCoordinator,
  createDesktopSupabaseAuth,
  type DesktopAuthCallbackState,
  type DesktopAuthCoordinator,
  type DesktopSupabaseAuthHost,
} from './desktopSupabaseAuth.js';
import { buildDesktopMenuTemplate } from './desktopMenuTemplate.js';
import {
  isFatalDesktopShutdownRequested,
  reportFatalStartupError,
} from './fatalStartupError.js';
import { initializeDesktopCrashReporting } from './desktopCrashReporting.js';
import { initializeElectronPlatform } from './platform/index.js';
import { showDesktopWarningDialog } from './platform/warningDialog.js';
import {
  DESKTOP_DOCS_URL,
  postDesktopSettingsView,
} from '../shared/desktopCommandSurface.js';
import type { DesktopAgentExecutionHost } from './desktopAgentExecutionHost.js';

const moduleDirname = import.meta.dirname;
const desktopMainDir = findDesktopMainDir(moduleDirname);
const credentialLog = createLog('Setup Credentials');

/**
 * Maximum number of commits the renderer displays in the launcher banner.
 * Mirrors the extension's `texra.git.numberOfCommitsToShow` default (20). The
 * desktop has no per-user override.
 */
const DESKTOP_RECENT_COMMIT_LIMIT = 20;
let mainWindow: BrowserWindow | null = null;
let reopenMainWindow: (() => void) | undefined;
let continueQuitAfterWindowClose: (() => void) | undefined;
// Serializes the lifecycle promises returned by each window's diff-host
// disposal. The disposal call itself still starts synchronously in the
// window-root store's disposal; only the returned completion promise is
// queued, so a window's `disposed` flag flips before earlier cleanup settles.
// The lifecycle shutdown drain awaits the queue's idle, so recursive temp-dir
// removals finish before the process exits instead of racing the quit flow.
const diffHostDisposeQueue = new PQueue({ concurrency: 1 });

// Playwright tests need a deterministic Electron profile so app-scoped stores
// survive across launches. Normal desktop launches keep Electron's default
// userData path.
const e2eUserDataPath = process.env.TEXRA_DESKTOP_E2E_USER_DATA_PATH;
if (e2eUserDataPath) {
  app.setPath('userData', resolvePath(e2eUserDataPath));
}

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
  log: console,
});

function findDesktopMainDir(startDir: string): string {
  let currentDir = startDir;
  for (let depth = 0; depth < 3; depth += 1) {
    if (
      existsSync(join(currentDir, '../preload/index.cjs')) &&
      existsSync(join(currentDir, '../renderer/index.html'))
    ) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  return startDir;
}

// The packaged renderer uses Lit style attributes and bundled font data URLs
// (codicons/KaTeX). Keep script execution locked to app files while allowing
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
  authCoordinator: DesktopAuthCoordinator;
  authCallbackState: DesktopAuthCallbackState;
  /**
   * The process services the composition root built (see
   * `ElectronPlatformInitResult`). Handed down so the window's controllers and
   * IPC surfaces take their stores from their owner rather than re-reading the
   * ambient `platform()` singleton.
   */
  globalState: StateStore;
  secrets: PlatformSecrets;
  agentDirectories: AgentDirectoriesPort;
  /** See ElectronPlatformInitResult.resourcesPath. */
  resourcesPath: string;
}): void {
  const activeProject = () => options.projects.active();
  const initialProject = activeProject();
  const initialWindowTitle = getDesktopWindowTitle(
    initialProject.session,
    initialProject.root,
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
    // so the task shell header becomes the drag region. On Windows/Linux,
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
      preload: join(desktopMainDir, '../preload/index.cjs'),
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
  // Project root: every resource bound to the project the window shows (its
  // title, its settings surface, its progress bridge) registers here and is
  // replaced when the window switches projects.
  let projectResources = new DisposableStore();
  let attachedProject: DesktopProject | undefined;
  windowResources.add(() => {
    const project = attachedProject;
    attachedProject = undefined;
    if (project)
      void runInSession(project.session, () => projectResources.dispose());
    else projectResources.dispose();
  });
  const ipcRef: {
    current?: { postToRenderer(message: unknown): void };
  } = {};
  // `installDesktopHostBridge.postToRenderer` is itself a no-op when
  // `webContents.isDestroyed()`. Without checking that here too, callers would
  // falsely report success and skip their external-viewer fallback. Shared by
  // the prompt controller, preview host, agent-execution wiring, and the
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
  const showMessageBoxOfType =
    (type: 'error' | 'info' | 'warning') => async (message: string) => {
      await dialog.showMessageBox(window, { type, message });
    };
  const showErrorMessage = showMessageBoxOfType('error');
  const reportAsyncError = (error: unknown) => {
    console.error('Desktop asynchronous operation failed:', error);
    effectRuntime().runFork(
      hostPort(() =>
        showErrorMessage(
          `A desktop operation failed: ${toErrorMessage(error)}`,
        ),
      ).pipe(
        Effect.catch((notificationError) =>
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
  installDesktopNavigationPolicy(window.webContents, {
    onAsyncError: reportAsyncError,
  });
  const showInfoMessage = showMessageBoxOfType('info');
  const showWarningMessage = showMessageBoxOfType('warning');
  // Shared shape for the "confirm this action" dialog: a warning with a
  // confirm button (defaulted, id 0) and a 'Cancel' button (id 1), collapsed
  // to a boolean. Used by confirmAcceptFile, the agent-settings confirm
  // prompt, the credential-settings confirm prompt, and settingsUi.confirmAction.
  const confirmDialog = async (options: {
    message: string;
    title?: string;
    detail?: string;
    confirmLabel?: string;
  }): Promise<boolean> => {
    const result = await dialog.showMessageBox(window, {
      type: 'warning',
      title: options.title,
      message: options.message,
      detail: options.detail,
      buttons: [options.confirmLabel ?? 'OK', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    return result.response === 0;
  };
  /**
   * Sole owner of the native unavailable-member prompt. Both the main-view
   * launch path and settings path route here so wording and button labels
   * cannot drift.
   */
  const presentTeamAvailabilityPrompt = async (
    prompt: TeamAvailabilityPrompt,
  ): Promise<'sign-in' | 'continue' | 'cancel'> => {
    const { response } = await dialog.showMessageBox(window, {
      type: prompt.severity,
      message: prompt.message,
      buttons: prompt.actions.map((action) => action.label),
      defaultId: 0,
      cancelId: 2,
    });
    return prompt.actions[response]?.choice ?? 'cancel';
  };
  // Lightweight update check: at most once/day, notifies at most once per
  // release via a native dialog linking to the GitHub release page. Not a full
  // updater: no download, no install, no feed files. Disable with
  // TEXRA_NO_UPDATE_CHECK=1. `createWindow` only ever runs inside the
  // `app.whenReady()` block, which the lock-losing process never reaches, so
  // no extra single-instance gate is needed here; `checkForDesktopUpdate`
  // itself dedupes concurrent calls and window reopens.
  effectRuntime().runFork(
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
  const getCustomAgentDirectory = () => options.agentDirectories.custom();

  // Button labels for the instruction dialog below. Desktop has one settings
  // home (Settings tab), so SET_API_KEY opens it directly rather than the
  // extension's separate "enter a key" quick pick.
  const INSTRUCTION_ACTION_BUTTON_LABELS: Record<InstructionAction, string> = {
    [INSTRUCTION_ACTION.SET_API_KEY]: 'Set API Key',
    [INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE]: 'Configuration Guide',
    [INSTRUCTION_ACTION.OPEN_MODELS_DOC]: 'Model Documentation',
  };
  /** Open a documentation URL without keeping the caller waiting; the browser
   *  never opening is reported, not swallowed. */
  const openExternalInBackground = (url: string): void => {
    effectRuntime().runFork(
      hostPort(() => previewHost.openExternal(url)).pipe(
        Effect.catch((error) =>
          Effect.sync(() => reportBackgroundError(error)),
        ),
      ),
    );
  };
  const dispatchInstructionAction = (action: InstructionAction): void => {
    switch (action) {
      case INSTRUCTION_ACTION.SET_API_KEY:
        postDesktopSettingsView(postToRendererIfAlive, 'models');
        return;
      case INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE:
        openExternalInBackground('https://texra.ai/guide/configuration.html');
        return;
      case INSTRUCTION_ACTION.OPEN_MODELS_DOC:
        openExternalInBackground('https://texra.ai/guide/models.html');
        return;
    }
  };
  /**
   * Instructions (e.g. a missing API key) are actionable guidance, not
   * failures, so this stays an 'info' dialog — but each action token now
   * renders as a real button instead of degrading to trailing hint text with
   * nothing to click. `showSuppress` still has no affordance to attach to: a
   * native dialog has no persistent "never remind again" control.
   */
  const showInstructionDialog = async (
    message: string,
    actions: readonly InstructionAction[] | undefined,
  ): Promise<void> => {
    const tokens = actions ?? [];
    const buttons = [
      ...tokens.map((token) => INSTRUCTION_ACTION_BUTTON_LABELS[token]),
      'Dismiss',
    ];
    const dismissId = buttons.length - 1;
    const { response } = await dialog.showMessageBox(window, {
      type: 'info',
      message,
      buttons,
      defaultId: dismissId,
      cancelId: dismissId,
    });
    const action = tokens[response];
    if (action) dispatchInstructionAction(action);
  };
  let teamSignInPending = false;
  const refreshDesktopAuthSurfaces = async () => {
    await Promise.all(
      [...projectBindings.values()].map((binding) =>
        effectRuntime().runPromise(binding.snapshot.refreshAuth),
      ),
    );
    await settingsIpcRef.current?.refreshAuthDependentData({
      deferAgentCatalogRefresh: teamSignInPending,
    });
    await onboardingIpcRef.current?.refreshOnboardingFunnel();
  };
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
      coordinator: options.authCoordinator,
      oauthClient: SupabaseClient.getClient(),
      callbackState: options.authCallbackState,
      host: desktopAuthHost,
      log: console,
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
  const signIn = async (): Promise<void> => {
    const provider = await chooseOAuthProvider();
    if (provider === undefined) return;
    await desktopAuth.signIn(provider);
  };
  const signInForRemoteAgentCatalog = async (): Promise<boolean> => {
    const provider = await chooseOAuthProvider();
    if (provider === undefined) return false;
    teamSignInPending = true;
    try {
      return (
        (await desktopAuth.signInAndWaitForSession(provider)) &&
        (await SupabaseClient.isAuthenticated())
      );
    } finally {
      teamSignInPending = false;
    }
  };
  initializeDesktopSetupAuth();
  windowResources.add(registerDesktopSetupSignIn(signInForRemoteAgentCatalog));
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
    effectRuntime().runFork(
      options.projects
        .activate(project.root)
        .pipe(
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
    effectRuntime().runFork(
      options.projects
        .close(root)
        .pipe(
          Effect.catch((error) => Effect.sync(() => reportAsyncError(error))),
        ),
    );
  };

  const openWorkspaceFolder = async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Open Workspace Folder',
      defaultPath: folderPickerDefaultPath(),
      properties: ['openDirectory'],
    });
    const selectedPath = result.canceled ? undefined : result.filePaths[0];
    if (!selectedPath) return;
    const project = await effectRuntime().runPromise(
      options.projects.open(selectedPath),
    );
    if (project.root !== undefined) selectProject(project.key);
  };
  attachRendererConsoleLog(window.webContents);
  const desktopDiffHost = createDesktopDiffHost({
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
   * Await a host promise the caller has already started, reporting rather than
   * raising its failure: a dialog that could not be shown must not fail the
   * execution behind it, and a temp-dir removal that could not finish must not
   * stall the quit drain that waits on it.
   */
  const awaitOrReport = (started: Promise<void>): Promise<void> =>
    effectRuntime().runPromise(
      hostPort(() => started).pipe(
        Effect.catch((error) =>
          Effect.sync(() => reportBackgroundError(error)),
        ),
      ),
    );
  // Not fire-and-forget: every quit path reaches the before-quit handler,
  // whose lifecycle drain awaits the dispose queue's idle before the final
  // quit. `desktopDiffHost.dispose()` is invoked synchronously here (so
  // `disposed` flips immediately); the queue only orders when this window's
  // completion promise resolves, keeping a macOS dock-reopen from discarding
  // an earlier window's still-running cleanup.
  windowResources.add(() => {
    const settled = awaitOrReport(desktopDiffHost.dispose());
    void diffHostDisposeQueue.add(() => settled);
  });
  const requestDiffHost = createDesktopDiffHost({
    openPath: requestPreviewHost.openPath,
    postToRenderer: postToRendererIfAlive,
  });
  windowResources.add(() => {
    const settled = awaitOrReport(requestDiffHost.dispose());
    void diffHostDisposeQueue.add(() => settled);
  });
  const agentExecutionHost: DesktopAgentExecutionHost = {
    openPath: previewHost.openPath,
    openBuildDisplay: previewHost.openBuildDisplay,
    openDiff: desktopDiffHost.openDiff,
    confirmAcceptFile: (message) =>
      confirmDialog({ message, confirmLabel: 'Replace file' }),
    chooseTeamAvailability: (unavailableNames) =>
      presentTeamAvailabilityPrompt(teamAvailabilityPrompt(unavailableNames)),
    signInForRemoteAgentCatalog,
    // Presentation failures are reported, never raised: an execution must not
    // fail because a dialog could not be shown. The caller still awaits the
    // dialog, as it did before.
    showInfoMessage: (message) => awaitOrReport(showInfoMessage(message)),
    showWarningMessage,
    showErrorMessage: (message) => awaitOrReport(showErrorMessage(message)),
    showInstructionDialog,
    pickTranscriptExportFormat: async () => {
      const { TRANSCRIPT_EXPORT_FORMAT_CHOICES } =
        await import('@controllers/progressView/exportTranscript');
      const { response } = await dialog.showMessageBox(window, {
        type: 'question',
        message: 'Export transcript',
        detail: 'Choose a format',
        buttons: [
          ...TRANSCRIPT_EXPORT_FORMAT_CHOICES.map((choice) => choice.label),
          'Cancel',
        ],
        defaultId: 0,
        cancelId: TRANSCRIPT_EXPORT_FORMAT_CHOICES.length,
      });
      return TRANSCRIPT_EXPORT_FORMAT_CHOICES[response]?.format;
    },
  };
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
  const recentCommitsOf = async (workspacePath: string | undefined) => {
    if (!workspacePath) return { commits: [] as string[], isGitRepo: false };
    return readRecentCommits(workspacePath, DESKTOP_RECENT_COMMIT_LIMIT, {
      onError: reportBackgroundError,
    });
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
    readonly execution: ReturnType<typeof createDesktopAgentExecution>;
    readonly workspace: ReturnType<typeof createDesktopWorkspaceIpc>;
    readonly browserViews: ReturnType<typeof createDesktopBrowserViews>;
    dispose(): void;
  }
  const projectBindings = new Map<string, ProjectBinding>();
  const bindProject = (project: DesktopProject): ProjectBinding => {
    const { workspace, browserViews } = createProjectWorkspace(project);
    const files = createDesktopFileSelection({
      workspacePath: project.root,
      showOpenFileDialog: openFileDialog,
    });
    // Install the recipient before host requests publish the recorder's state.
    const bridge = new SessionBridge({
      session: project.session,
      handleHostRequest: (request, portId) =>
        hostRequests.handle(request, portId),
      onPortClosed: (portId) => hostRequests.closePort(portId),
    });
    const snapshot = createHostSnapshotSource({
      project: projectDisplayOf(project.key, project.root),
      globalState: options.globalState,
      fileOptions: () => files.fileOptions(),
      readRecentCommits: () => recentCommitsOf(project.root),
      isAuthenticated: () => SupabaseClient.isAuthenticated(),
      onError: reportBackgroundError,
      publish: (next) => bridge.setHost(next),
    });
    const funnel = onboardingIpcRef.current?.funnelState();
    if (funnel) snapshot.setOnboarding(funnel);
    const execution = createDesktopAgentExecution({
      host: agentExecutionHost,
      toolEditPreview: {
        openPath: requestPreviewHost.openPath,
        openBuildDisplay: requestPreviewHost.openBuildDisplay,
        openDiff: requestDiffHost.openDiff,
      },
      session: project.session,
      showAgentConfigBanner: ({ agentName, category }) =>
        snapshot.showAgentConfigBanner(agentName, category),
      onLaunched: (streamId) =>
        bridge.surfaceAction({ kind: 'select', streamId }),
    });
    const hostRequests = createDesktopHostRequests({
      session: project.session,
      draftRequests: hostDraftRequests,
      host: {
        ...agentExecutionHost,
        openPath: requestPreviewHost.openPath,
        openBuildDisplay: requestPreviewHost.openBuildDisplay,
        openDiff: requestDiffHost.openDiff,
      },
      execution,
      files,
      snapshot,
      workspacePath: project.root,
      resourcesPath: options.resourcesPath,
      postToRenderer: postToRendererIfAlive,
      postSurfaceAction: (action) => bridge.surfaceAction(action),
      signIn,
      getCustomAgentDirectory,
      showFirstRunWalkthrough: () => shellActions.showFirstRunWalkthrough(),
      onboarding: requireOnboardingIpc(),
      openExternalUrl: requestPreviewHost.openExternal,
      recheckTools: async () => {
        await effectRuntime().runPromise(refreshToolAvailability());
      },
      logger: console,
    });
    const port = bridge.attach({
      id: `window:${window.id}`,
      send: (message) => {
        postToRendererIfAlive(message);
      },
    });
    void effectRuntime().runPromise(snapshot.refresh);
    return {
      project,
      bridge,
      port,
      snapshot,
      execution,
      workspace,
      browserViews,
      dispose() {
        workspace.disposeRendererResources();
        workspace.dispose();
        bridge.dispose();
        hostRequests.dispose();
        execution.dispose();
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
      void runInSession(binding.project.session, () => binding.dispose());
    }
    for (const [key, project] of open) {
      if (projectBindings.has(key)) continue;
      projectBindings.set(
        key,
        runInSession(project.session, () =>
          bindProject(project),
        ) as ProjectBinding,
      );
    }
  };
  windowResources.add(() => {
    for (const binding of projectBindings.values()) {
      void runInSession(binding.project.session, () => binding.dispose());
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
  // Each project's catalogs are read inside its own session: the presets
  // come from that project's workspace state, not the caller's.
  const refreshCatalogs = async () => {
    await Promise.all(
      [...projectBindings.values()].map((binding) =>
        runInSession(binding.project.session, () =>
          effectRuntime().runPromise(binding.snapshot.refreshCatalogs),
        ),
      ),
    );
  };
  const subscriptionUsage = new SubscriptionUsageService();
  const settingsUi: DesktopSettingsUiHost = {
    showInfoMessage,
    showErrorMessage,
    confirmAction: (message, confirmLabel) =>
      confirmDialog({ message, confirmLabel }),
    openPath: previewHost.openPath,
    // Selection is the surface's: a settings jump asks the shown project's
    // surface to select the stream, and reports a stream the view no longer
    // holds as missing.
    revealStream: async (streamId) => {
      const binding = activeBinding();
      if (!binding) return 'unavailable';
      const view = SubscriptionRef.getUnsafe(binding.project.session.view);
      if (!view.streams.has(streamId)) return 'missing';
      binding.bridge.surfaceAction({ kind: 'select', streamId });
      return 'revealed';
    },
    getStreamLabel: (streamId) =>
      SubscriptionRef.getUnsafe(activeProject().session.view).streams.get(
        streamId,
      )?.label,
    promptForSecret: (input) =>
      promptController.request({ ...input, password: true }),
    // Not previewHost.openExternal: that one shows an error dialog and
    // rethrows a rewrapped error, which this surface's caller does not expect.
    openExternal: async (url) => {
      await shell.openExternal(url);
    },
    onError: reportAsyncError,
  };
  const requireSettingsIpc = (): DesktopSettingsIpc => {
    const settingsIpc = settingsIpcRef.current;
    if (!settingsIpc) throw new Error('Desktop settings IPC is not attached.');
    return settingsIpc;
  };
  const postProjects = () => {
    postToRendererIfAlive({
      command: DESKTOP_PROJECT_COMMANDS.PROJECTS,
      ...options.projects.summary(),
    });
  };
  /**
   * Bind the window to the project it shows. The settings controllers read the
   * project's workspace state and config, the settings surface subscribes to
   * the project's session (goal facts, approval policy), the title follows its
   * activity. These active settings bindings are replaced on selection;
   * the session bridge and workbench remain with their project.
   */
  const attachActiveProject = (documentChanged = false) => {
    const project = activeProject();
    if (project === attachedProject && !documentChanged) return;
    const documentBinding = projectBindings.get(project.key);
    const previous = attachedProject;
    const previousResources = projectResources;
    attachedProject = project;
    projectResources = new DisposableStore();
    const owner = projectResources;
    const postForActiveProject = (message: unknown) => {
      if (projectResources !== owner) return false;
      return postToRendererIfAlive(message);
    };
    if (previous) {
      void runInSession(previous.session, () => previousResources.dispose());
    }
    projectResources.add(
      installDesktopWindowTitle(window, project.session, project.root),
    );
    const agentSettingsController = new DefaultDesktopAgentSettingsController({
      workspaceState: project.roots.workspaceState,
      globalState: options.globalState,
      registry: {
        loadAgents,
        refreshAgents: refresh,
        loadAgentOptionsData: computeAgentOptionsData,
        getAgents: getAgentsByCategory,
        getVisibleAgents,
      },
      directory: {
        getCustomAgentDirectory,
        getSourceDirectory: (source: AgentSource) => {
          switch (source) {
            case 'custom':
              return options.agentDirectories.custom();
            case 'builtInWorkflow':
              return options.agentDirectories.builtIn();
            case 'builtInToolUse':
              return options.agentDirectories.builtInToolUse();
            // No local directory: remote agents live in Supabase, inline ones
            // were supplied as values and were never written to disk.
            case 'remote':
            case 'inline':
              return Promise.resolve(undefined);
          }
        },
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
        canAccess: () => SupabaseClient.isAuthenticated(),
        signIn: signInForRemoteAgentCatalog,
      },
      notifications: { showInfoMessage, showErrorMessage },
      resourcesPath: options.resourcesPath,
      onCatalogChanged: async (selectedToolUseAgent) => {
        await refreshCatalogs();
        if (!selectedToolUseAgent) return;
        const binding = projectBindings.get(project.key);
        if (!binding || binding !== documentBinding) return;
        binding.bridge.surfaceAction({
          kind: 'launch',
          patch: { agent: { toolUse: selectedToolUseAgent } },
        });
      },
    });
    const credentialSettingsController =
      new DefaultDesktopCredentialSettingsController({
        workspaceState: project.roots.workspaceState,
        globalState: options.globalState,
        config: project.roots.config,
        secrets: options.secrets,
        renderer: {
          postToRenderer: postForActiveProject,
        },
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
        },
        externalOpener: {
          openExternal: previewHost.openExternal,
          openSubscriptionSignInUrl: (url) =>
            previewHost.openExternal(url, { reportFailure: false }),
          presentSubscriptionSignInUrl: async (url, productName) => {
            const result = await dialog.showMessageBox(window, {
              type: 'info',
              message: `Signing in with ${productName}`,
              detail:
                `Opened your default browser. Using a different browser for ${productName}? ` +
                'Open this link there instead:\n\n' +
                `${url}`,
              buttons: ['Copy Sign-in Link', 'Close'],
              defaultId: 0,
              cancelId: 1,
            });
            if (result.response === 0) {
              clipboard.writeText(url);
            }
          },
          presentSubscriptionDeviceCode: async (prompt, productName) => {
            // The code is copied up front: the dialog closes on any button, so
            // the user must not have to keep it open to read the code back.
            clipboard.writeText(prompt.userCode);
            const result = await dialog.showMessageBox(window, {
              type: 'info',
              message: `Sign in with ${productName}`,
              detail:
                `No browser could take the sign-in callback, so ${productName} ` +
                'is signing in with a one-time code instead.\n\n' +
                `1. Open ${prompt.verificationUrl}\n` +
                `2. Enter the code: ${prompt.userCode} (copied to the clipboard)\n\n` +
                'TeXRA is waiting for you to approve it.',
              buttons: ['Open Verification Page', 'Close'],
              defaultId: 0,
              cancelId: 1,
            });
            if (result.response === 0) {
              await previewHost.openExternal(
                prompt.verificationUrlComplete ?? prompt.verificationUrl,
              );
            }
          },
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
        subscriptionUsage,
        onCredentialChanged: async () => {
          await onboardingIpcRef.current?.refreshOnboardingFunnel();
        },
        onModelOptionsChanged: refreshCatalogs,
        // Credential operations already show their specific failure dialog. Keep
        // the shared callback log-only so one failure never opens a second,
        // generic desktop-operation dialog.
        onError: reportBackgroundError,
      });
    const toolingSettingsController =
      new DefaultDesktopToolingSettingsController({
        onError: reportAsyncError,
        workspaceState: project.roots.workspaceState,
        globalState: options.globalState,
        config: project.roots.config,
        renderer: {
          postToRenderer: postForActiveProject,
        },
        dashboard: {
          buildItems: async (cachedResults) => {
            const { buildToolDashboardItems } =
              await import('@controllers/settingsView/ToolDashboardData');
            return effectRuntime().runPromise(
              buildToolDashboardItems('desktop', cachedResults),
            );
          },
          getCachedCheckResults: async () => getLastCheckResults() ?? undefined,
          refreshAvailability: () =>
            effectRuntime().runPromise(refreshToolAvailability()),
          planTerminalAction: async (toolId, kind) => {
            const { planToolTerminalAction } =
              await import('@controllers/settingsView/ToolDashboardData');
            return planToolTerminalAction({ toolId, commandKind: kind });
          },
        },
        navigation: { openExternal: previewHost.openExternal },
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
          findPath: (tool) => BinaryResolver.findPath(tool),
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
    projectResources.add(() => toolingSettingsController.dispose());
    const settingsIpc = createDesktopSettingsIpc({
      postToRenderer: postForActiveProject,
      agentSettingsController,
      credentialSettingsController,
      toolingSettingsController,
      globalState: options.globalState,
      secrets: options.secrets,
      ui: settingsUi,
      session: project.session,
    });
    settingsIpcRef.current = settingsIpc;
    // Holds project-scoped subscriptions (goal state and app signals) that
    // would otherwise accumulate one listener per switch or dock reactivation.
    projectResources.add(() => {
      if (settingsIpcRef.current === settingsIpc) {
        settingsIpcRef.current = undefined;
      }
      settingsIpc.dispose();
    });
  };
  windowResources.add(
    options.projects.onChange(() => {
      syncProjectBindings();
      if (activeProject() !== attachedProject) {
        for (const binding of projectBindings.values())
          binding.browserViews.hideAll();
      }
      attachActiveProject();
      postProjects();
    }),
  );
  const onboardingIpc = createDesktopOnboardingIpc(
    { postToRenderer: postToRendererIfAlive },
    {
      state: options.globalState,
      // Single source of truth for "does the user have a usable credential",
      // shared by every host (extension, desktop, CLI) so this credential-gating
      // logic can't drift between them.
      hasCredential: () =>
        hasUsableSetupCredential(options.secrets, credentialLog.warn),
      // The setup card launches its own request (`kickoffSetup` below), so
      // the launcher's agent selection, which is the surface's (PRD 9),
      // is not moved from here.
      selectSetupAgent: async () => {},
      // Launch the setup conversation when the user clicks "Run Setup" on the
      // setup card, mirroring the extension's `launchSetupAssistant` →
      // launch path: resolve a model the user's credentials can call,
      // build the setup execute message, and run it through the same desktop
      // execute path the renderer's Execute button uses. The per-session
      // `setupKickoffStarted` dedup guard inside the onboarding IPC keeps this
      // one-shot; on a resolution failure it throws so that guard resets and a
      // later "Run Setup" click can retry.
      kickoffSetup: async () => {
        const setupSession = activeProject().session;
        await effectRuntime().runPromise(
          Effect.tryPromise({
            try: async () => {
              // The project the user started setup in, taken before the first await:
              // the run and its presentation belong to it even when the window
              // moves to another project while the model resolves and agents load.
              const binding = activeBinding();
              if (!binding) {
                throw new Error('Open a folder before running setup.');
              }
              const { buildDesktopSetupExecuteMessage } =
                await import('@controllers/onboarding/setupLaunch');
              const message = await buildDesktopSetupExecuteMessage();
              if (!message) {
                throw new Error(
                  'No model is available for your current credentials. Sign in with ChatGPT or add a provider or coding-plan API key in Models, then try setup again.',
                );
              }
              // Idempotent: joins the in-flight/initialized registry so a kickoff
              // racing the startup `loadAgents()` cannot hit "Could not find agent:
              // setup" (mirrors `setupAssistantCommand.launchSetupAssistant`).
              await effectRuntime().runPromise(loadAgents());
              await runInSession(binding.project.session, async () =>
                binding.execution.runValidated(
                  await effectRuntime().runPromise(
                    prepareMainViewExecutionLaunch(message, agentExecutionHost),
                  ),
                ),
              );
            },
            catch: (error) => error,
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                if (error instanceof Cancelled) return;
                // Setup continues after its initiating request has completed.
                const primaryError = primaryAgentError(error);
                const presentation = agentErrorPresentation({
                  kind: classifyAgentError(primaryError),
                  message:
                    primaryError instanceof Rejected
                      ? primaryError.reason
                      : toErrorMessage(primaryError),
                });
                if (
                  presentation?.type === 'instruction' ||
                  presentation?.type === 'error'
                ) {
                  yield* Effect.tryPromise({
                    try: () =>
                      Promise.resolve(
                        setupSession.interactions.emit(
                          presentation.type === 'instruction'
                            ? 'requestShowInstruction'
                            : 'requestShowError',
                          presentation.payload,
                          { replayWhenAttached: true },
                        ),
                      ),
                    catch: (emitError) => emitError,
                  });
                }
                return yield* Effect.fail(error);
              }),
            ),
          ),
        );
      },
      signInWithChatGpt: () => requireSettingsIpc().signInChatGpt(),
      // The desktop shell can't host the VS Code getting-started walkthrough, so
      // the State 0 walkthrough button opens the desktop docs externally — the
      // closest desktop analog, reusing the same docs URL the Help menu's
      // "Desktop Documentation" item opens.
      openGettingStarted: () => previewHost.openExternal(DESKTOP_DOCS_URL),
      onAsyncError: reportAsyncError,
    },
  );
  onboardingIpcRef.current = onboardingIpc;
  // The funnel is host state every open project's snapshot carries (8.1).
  windowResources.add(
    onboardingIpc.onFunnelChange((state) => {
      for (const binding of projectBindings.values()) {
        binding.snapshot.setOnboarding(state);
      }
    }),
  );
  effectRuntime().runFork(
    hostPort(() => onboardingIpc.refreshOnboardingFunnel()).pipe(
      Effect.catch((error) => Effect.sync(() => reportAsyncError(error))),
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
      onAsyncError: reportAsyncError,
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
      openExternalUrl: (url) => previewHost.openExternal(url),
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
        getEnvironmentSummary: async () =>
          project.root
            ? ((await readGitEnvironmentSummary(project.root, {
                onError: reportBackgroundError,
              })) ?? EMPTY_DESKTOP_ENVIRONMENT_SUMMARY)
            : EMPTY_DESKTOP_ENVIRONMENT_SUMMARY,
        onAsyncError: reportAsyncError,
      },
    );
    return { workspace, browserViews };
  }
  const workspaceIpc = {
    handleMessage(
      message: Parameters<DesktopMessageHandler['handleMessage']>[0],
    ) {
      const parsed = DesktopWorkspaceInboundMessageSchema.safeParse(message);
      if (!parsed.success) return false;
      const binding = projectBindings.get(parsed.data.session);
      if (!binding) {
        console.warn(
          `Dropped a workspace request for closed project ${parsed.data.session}`,
        );
        return true;
      }
      // Hidden projects retain their resources, but cannot cover the visible project
      // with a late browser-bounds notification.
      if (
        parsed.data.command === DESKTOP_WORKSPACE_COMMANDS.BROWSER_BOUNDS &&
        binding.project !== activeProject()
      )
        return true;
      runInSession(binding.project.session, () =>
        binding.workspace.handleMessage(message),
      );
      return true;
    },
    disposeRendererResources() {
      // Navigation destroys the document, including its request correlations
      // and recording ownership. Replace its ports while retaining sessions.
      for (const binding of projectBindings.values()) {
        runInSession(binding.project.session, () => binding.dispose());
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
      copyLog: async (text) => clipboard.writeText(text),
      exportLog: async (text) => {
        const result = await dialog.showSaveDialog(window, {
          title: 'Export TeXRA Desktop Log',
          defaultPath: 'texra-desktop-log.txt',
          filters: [{ name: 'Text Logs', extensions: ['txt', 'log'] }],
        });
        if (result.canceled || !result.filePath) return;
        await writeFile(result.filePath, text, 'utf8');
      },
      onAsyncError: reportAsyncError,
    },
  );
  // The desktop-only handlers, in match order. A message every one of them
  // declines is a session message: the project it names answers it inside
  // that project's session scope.
  // Renderer traffic about projects: the list it asks for once it boots, and
  // the select and close requests. safeParse, not parse: dispatch runs under
  // `runInSession` with no catch, so a malformed message is dropped, not an
  // unhandled rejection.
  const projectsIpc: DesktopMessageHandler = {
    handleMessage(message) {
      switch (message.command) {
        case DESKTOP_PROJECT_COMMANDS.REQUEST_PROJECTS:
          postProjects();
          return true;
        case DESKTOP_PROJECT_COMMANDS.SELECT_PROJECT: {
          const parsed = DesktopSelectProjectMessageSchema.safeParse(message);
          if (parsed.success) selectProject(parsed.data.key);
          return true;
        }
        case DESKTOP_PROJECT_COMMANDS.CLOSE_PROJECT: {
          const parsed = DesktopCloseProjectMessageSchema.safeParse(message);
          if (parsed.success)
            closeProject(parsed.data.key, parsed.data.hasUnsavedChanges);
          return true;
        }
        default:
          return false;
      }
    },
  };
  const desktopHandlers: DesktopMessageHandler[] = [
    promptController,
    {
      handleMessage: (message) =>
        settingsIpcRef.current?.handleMessage(message) ?? false,
    },
    onboardingIpc,
    projectsIpc,
    workspaceIpc,
    logsIpc,
    createDesktopShellIpc(shellActions),
  ];
  const hostBridge = installDesktopHostBridge(window, {
    onRendererMessage: (message) => {
      if (isDesktopCommandMessage(message)) {
        void runInSession(activeProject().session, () => {
          for (const handler of desktopHandlers) {
            if (handler.handleMessage(message)) return;
          }
        });
        return;
      }
      // A session message names its project: that project's port answers it
      // inside the project's session scope.
      const addressed = SessionMessageEnvelopeSchema.safeParse(message);
      if (!addressed.success) return;
      const binding = projectBindings.get(addressed.data.session);
      if (!binding) {
        console.warn(
          `Dropped a renderer message for session ${addressed.data.session}: not open`,
        );
        return;
      }
      runInSession(binding.project.session, () =>
        binding.port.receive(message),
      );
    },
  });
  windowResources.add(() => {
    promptController.dispose();
    hostBridge.dispose();
  });
  ipcRef.current = { postToRenderer: hostBridge.postToRenderer };
  syncProjectBindings();
  attachActiveProject();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(buildDesktopMenuTemplate(shellActions)),
  );
  window.once('closed', () => {
    const continueQuit = continueQuitAfterWindowClose;
    continueQuitAfterWindowClose = undefined;
    effectRuntime().runSync(
      Effect.try({
        try: () => windowResources.dispose(),
        catch: (error) => error,
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
    continueQuit?.();
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

  void window.loadFile(join(desktopMainDir, '../renderer/index.html'));
}

if (protocolLifecycle.ownsSingleInstanceLock) {
  app
    .whenReady()
    .then(async () => {
      // Every resume call is run-time or user-triggered, so the registry is
      // open by the time the owner reads it.
      let projects!: DesktopProjectRegistry;
      const processResumeOwner = new DesktopProcessResumeOwner({
        sessions: () =>
          [projects.fallback(), ...projects.list()].map((p) => p.session),
      });
      const platformInit = await initializeElectronPlatform(
        desktopMainDir,
        processResumeOwner,
      );
      const { lifecycle } = platformInit;
      // Process root: session-lifetime resources register at creation and are
      // disposed LIFO in the ON phase (every project's process stores → result
      // toast → session, most recently opened first).
      const processResources = new DisposableStore();
      registerRuntimeShutdownHandlers(lifecycle, {
        runSettlement: (settlement) => effectRuntime().runPromise(settlement),
        beforeAgentShutdown: [() => processResumeOwner.disable()],
        afterAgentShutdown: [() => killActiveRecording()],
        // Agent shutdown runs first so its final events enter the
        // process-owned stores. Flush in BEFORE so persistence cannot be
        // delayed by a later ON-phase language-service disposal.
        flushArtifacts: () => projects.flushArtifacts(),
        // Each window's closed handler starts diff temp-dir removal before the
        // quit lifecycle drains; awaiting idle keeps the process alive until
        // the directories are actually gone.
        afterFlushArtifacts: [() => diffHostDisposeQueue.onIdle()],
        afterExecutionSettlement: [
          () => processResources.dispose(),
          // Last: every project's session has released its graph above.
          () => disposeProcessRuntime(),
        ],
      });

      // Until the initial window is fully wired, any startup failure must run
      // the same process-session shutdown used by an ordinary application
      // exit. Once this program completes, the lifecycle owns that cleanup.
      // The original failure is re-raised, not the fold's envelope: the fatal
      // reporter below prints `error.stack`, which a wrapper would replace
      // with the runtime's own trace.
      const startup = await effectRuntime().runPromiseExit(
        hostPort(async () => {
          const warn = (message: string) =>
            console.warn(`[desktop] ${message}`);
          const projectRecords = await effectRuntime().runPromise(
            Scope.provide(
              openDesktopProjectRecords(
                app.getPath('userData'),
                platformInit.ownerId,
              ),
              effectRuntime().scope,
            ),
          );
          projects = await effectRuntime().runPromise(
            openDesktopProjectRegistry({
              dataRoot: platformInit.dataRoot,
              processRoots: platformInit.processRoots,
              globalConfigStore: platformInit.globalConfigStore,
              records: projectRecords,
              warn,
            }),
          );
          processResources.add(() => projects.dispose());
          // Reopen every folder left open last time and show the one shown
          // last. A folder that is gone or no longer opens is reported once the
          // window exists; the others open regardless.
          const remembered = await effectRuntime().runPromise(
            readRememberedDesktopProjects(projectRecords, warn),
          );
          const unopenedProjects = remembered.missing.map(
            (root) => `${root} (no such folder; forgotten)`,
          );
          for (const root of remembered.roots) {
            await effectRuntime().runPromise(
              projects.open(root).pipe(
                Effect.catch((error) =>
                  Effect.sync(() => {
                    unopenedProjects.push(`${root}: ${toErrorMessage(error)}`);
                  }),
                ),
              ),
            );
          }
          await effectRuntime().runPromise(
            projects.activate(projects.list().at(-1)?.root),
          );
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

          void initializeDesktopCrashReporting({
            sensitivePaths: () => [
              ...projects.list().map((project) => project.root),
              app.getPath('userData'),
              platformInit.dataRoot,
            ],
            log: console,
          });
          const authCoordinator = createDesktopAuthCoordinator({
            secrets: platformInit.secrets,
            log: console,
          });
          const authCallbackState = createDesktopAuthCallbackState(
            console,
            platformInit.globalState,
          );
          installContentSecurityPolicy();
          reopenMainWindow = () =>
            createWindow({
              projects,
              authCoordinator,
              authCallbackState,
              globalState: platformInit.globalState,
              secrets: platformInit.secrets,
              agentDirectories: platformInit.agentDirectories,
              resourcesPath: platformInit.resourcesPath,
            });
          reopenMainWindow();
          if (unopenedProjects.length > 0) {
            effectRuntime().runFork(
              hostPort(() =>
                showDesktopWarningDialog(
                  `Some projects could not be reopened:\n${unopenedProjects.join('\n')}`,
                ),
              ).pipe(
                Effect.catch((error) =>
                  Effect.sync(() => console.error(error)),
                ),
              ),
            );
          }

          app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0)
              reopenMainWindow?.();
          });
        }),
      );
      if (Exit.isFailure(startup)) {
        await lifecycle.runShutdown();
        throw Cause.squash(startup.cause);
      }
    })
    // The one catch this entry keeps. It guards `initializeElectronPlatform`
    // itself, which is what installs the process Effect runtime, so there is
    // no runtime to fold this failure on: a platform init that dies before
    // `installProcessRuntime` would make `effectRuntime()` throw over the
    // error it was meant to report. Electron's `whenReady()` promise is the
    // real foreign boundary here.
    .catch((error: unknown) => {
      reportFatalStartupError(error);
    });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
