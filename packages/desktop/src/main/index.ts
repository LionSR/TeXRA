import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
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

import type { SessionStores } from '@agent/storage';
import {
  agentResponseTextConnector,
  attachTerminalResultToast,
  SessionHandle,
  settleLiveSessionExecutions,
} from '@agent/runtime';
import {
  computeAgentOptionsData,
  getAgent,
  getAgentsByCategory,
  getVisibleAgents,
  loadAgents,
  refresh,
} from '@agent/index/agentRegistry';
import { SupabaseClient } from '@auth/SupabaseClient';
import {
  formatUnavailableTeamMembersMessage,
  TEAM_LAUNCH_CANCEL_LABEL,
  TEAM_LAUNCH_CONTINUE_LABEL,
  TEAM_LAUNCH_SIGN_IN_LABEL,
} from '@common/teams/TeamPlan';
import { LatexConfigPersistenceController } from '@controllers/settingsView/LatexConfigPersistenceController';
import { LatexToolingController } from '@controllers/settingsView/LatexToolingController';
import { prepareMainViewExecutionRequest } from '@controllers/mainView/MainViewExecutionController';
import { SubscriptionUsageService } from '@controllers/modelAccess/subscriptionUsage/SubscriptionUsageService';
import { createTexraResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import { hasUsableSetupCredential } from '@model/setupCredentialAccess';
import { platform } from '@platform/platform';
import { SHUTDOWN_PHASE } from '@platform/interfaces';
import { DisposableStore } from '@platform/disposable';
import { readPersistedTexraApprovalPolicy } from '@shared/approvalPolicy';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { AgentCategory, agentKeyOf, type AgentSource } from '@shared/schemas';
import { normalizePlatform } from '@shared/constants/latexToolchain';
import { registerAgentShutdownHandlers } from '@tools/agentCliSessionStores';
import { killActiveRecording } from '@tools/media/audio';
import { ephemeralTranscriptWarning, StreamLogStore } from '@transcript';
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
import { launchDesktopAgent } from './desktopAgentLaunch.js';
import { DesktopProcessResumeOwner } from './desktopAgentResume.js';
import { createDesktopDiffHost } from './desktopDiffHost.js';
import { initializeDesktopProcessStores } from './desktopProcessStores.js';
import { createDesktopFileSelection } from './desktopFileSelection.js';
import { createDesktopPreviewHost } from './desktopPreviewHost.js';
import { createDesktopBrowserViews } from './desktopBrowserViews.js';
import { createDesktopPtyHost } from './desktopPtyHost.js';
import { createDesktopWorkspaceIpc } from './desktopWorkspaceIpc.js';
import {
  DESKTOP_WORKSPACE_COMMANDS,
  EMPTY_DESKTOP_ENVIRONMENT_SUMMARY,
} from '../shared/desktopWorkspaceMessages.js';
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
import { createDesktopProgressIpc } from './desktopProgressIpc.js';
import { DefaultDesktopAgentSettingsController } from './desktopAgentSettingsController.js';
import { DefaultDesktopCredentialSettingsController } from './desktopCredentialSettingsController.js';
import {
  createDesktopSettingsIpc,
  type DesktopSettingsUiHost,
} from './desktopSettingsIpc.js';
import { DefaultDesktopToolingSettingsController } from './desktopToolingSettingsController.js';
import { chooseDesktopOAuthProvider } from './desktopOAuthProviderPrompt.js';
import { createDesktopShellActions } from './desktopShellIpc.js';
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
import { installDesktopMainViewIpc } from './mainViewIpc.js';
import { initializeDesktopCrashReporting } from './desktopCrashReporting.js';
import { initializeElectronPlatform } from './platform/index.js';
import { showDesktopWarningDialog } from './platform/warningDialog.js';
import { DESKTOP_DOCS_URL } from '../shared/desktopCommandSurface.js';
import {
  DESKTOP_WORKSPACE_PATH_STATE_KEY,
  serializeWorkspacePresenceArg,
  withWorkspacePathArg,
} from '../shared/workspacePath.js';
import type {
  DesktopAgentExecutionOptions,
  DesktopProgressBridge,
} from './desktopAgentExecution.js';
import type { DesktopAgentExecutionHost } from './desktopAgentExecutionHost.js';

const moduleDirname = fileURLToPath(new URL('.', import.meta.url));
const desktopMainDir = findDesktopMainDir(moduleDirname);

/**
 * Maximum number of commits the renderer displays in the launcher banner.
 * Mirrors the extension's `texra.git.numberOfCommitsToShow` default (20). The
 * desktop has no per-user override.
 */
const DESKTOP_RECENT_COMMIT_LIMIT = 20;
let mainWindow: BrowserWindow | null = null;
let reopenMainWindow: (() => void) | undefined;
// Both the relaunch payload and the "a relaunch is under way" fact. It stays
// set from the folder pick until the process is replaced, so `window-all-closed`
// leaves quitting to the relaunch path instead of racing it; only the user
// keeping a dirty editor clears it.
let pendingWorkspaceRelaunch:
  { selectedPath: string; args: string[] } | undefined;
let continueQuitAfterWindowClose: (() => void) | undefined;
// Serializes the lifecycle promises returned by each window's diff-host
// disposal. The disposal call itself still starts synchronously in the
// window-root store's disposal; only the returned completion promise is
// queued, so a window's `disposed` flag flips before earlier cleanup settles.
// The lifecycle shutdown drain awaits the queue's idle, so recursive temp-dir
// removals finish before the process exits instead of racing the quit flow.
const diffHostDisposeQueue = new PQueue({ concurrency: 1 });

// Playwright relaunch tests need a deterministic Electron profile so
// app-scoped stores survive across child processes. Normal desktop launches
// keep Electron's default userData path.
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

function createWindow(options: {
  workspacePath: string | undefined;
  authCoordinator: DesktopAuthCoordinator;
  authCallbackState: DesktopAuthCallbackState;
  processSession: SessionHandle;
  sessionStores: SessionStores;
  /** See ElectronPlatformInitResult.resourcesPath. */
  resourcesPath: string;
}): void {
  const initialWindowTitle = getDesktopWindowTitle(
    options.processSession,
    options.workspacePath,
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
      additionalArguments: [
        serializeWorkspacePresenceArg(options.workspacePath != null),
        ...(options.workspacePath
          ? [`--texra-workspace-path=${options.workspacePath}`]
          : []),
      ],
    },
  });
  mainWindow = window;
  // Window root: every resource scoped to this BrowserWindow registers here at
  // creation, and the `closed` handler disposes the store (LIFO) instead of
  // running a hand-ordered teardown ledger.
  const windowResources = new DisposableStore();
  windowResources.add(
    installDesktopWindowTitle(
      window,
      options.processSession,
      options.workspacePath,
    ),
  );
  const ipcRef: {
    current?: ReturnType<typeof installDesktopMainViewIpc>;
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
    current?: ReturnType<typeof createDesktopSettingsIpc>;
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
    void showErrorMessage(
      `A desktop operation failed: ${toErrorMessage(error)}`,
    ).catch((notificationError: unknown) => {
      console.error(
        'Failed to display desktop asynchronous operation error:',
        notificationError,
      );
    });
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
   * Sole owner of the "team has unavailable hosted members" prompt. Both the
   * main-view launch path and the settings path route here so the two can't
   * drift apart in wording or button labels again.
   */
  const chooseTeamAvailability = async (
    unavailableNames: readonly string[],
    presetName?: string,
  ): Promise<'sign-in' | 'continue' | 'cancel'> => {
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning',
      message: formatUnavailableTeamMembersMessage(
        unavailableNames,
        presetName,
      ),
      buttons: [
        TEAM_LAUNCH_SIGN_IN_LABEL,
        TEAM_LAUNCH_CONTINUE_LABEL,
        TEAM_LAUNCH_CANCEL_LABEL,
      ],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 0) return 'sign-in';
    if (response === 1) return 'continue';
    return 'cancel';
  };
  // Lightweight update check: at most once/day, notifies at most once per
  // release via a native dialog linking to the GitHub release page. Not a full
  // updater: no download, no install, no feed files. Disable with
  // TEXRA_NO_UPDATE_CHECK=1. Gated on owning the
  // single-instance lock so an "open folder in new window" launch (which
  // deliberately runs as its own process) never duplicates the check or
  // dialog alongside the primary process.
  if (protocolLifecycle.ownsSingleInstanceLock) {
    checkForDesktopUpdate({
      currentVersion: app.getVersion(),
      globalState: platform().globalState,
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
    }).catch(reportBackgroundError);
  }
  const previewHost = createDesktopPreviewHost({
    shell,
    showErrorMessage,
    // Prefer the in-app PDF overlay (an <iframe> inside a wa-dialog, so
    // Electron's bundled Chromium PDF viewer renders the build output).
    // Returning `false` when the IPC bridge is not yet wired (startup race)
    // or the BrowserWindow has been destroyed falls the host back to the
    // external viewer (`shell.openPath`) so previews never silently disappear.
    postToRenderer: postToRendererIfAlive,
  });
  let teamSignInPending = false;
  const refreshDesktopAuthSurfaces = async () => {
    const authenticated = await SupabaseClient.isAuthenticated();
    ipcRef.current?.postToRenderer({
      command: MAIN_VIEW_COMMANDS.SET_BANNER,
      banner: 'login',
      visible: !authenticated,
    });
    await settingsIpcRef.current?.refreshAuthDependentData({
      deferAgentCatalogRefresh: teamSignInPending,
    });
    await onboardingIpcRef.current?.refreshOnboardingFunnel();
  };
  const desktopAuthHost: DesktopSupabaseAuthHost = {
    openExternalUrl: (url) => previewHost.openExternal(url),
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
  const folderPickerDefaultPath = options.workspacePath ?? app.getPath('home');
  // The renderer owns editor dirtiness. This event is the main process's only
  // reading of it: Chromium emits it after the renderer's beforeunload handler
  // observes a dirty Monaco buffer and refuses the unload, so every close path
  // (quit, workspace switch, window close) asks here and nowhere else.
  window.webContents.on('will-prevent-unload', (event) => {
    if (isFatalDesktopShutdownRequested()) {
      pendingWorkspaceRelaunch = undefined;
      event.preventDefault();
      return;
    }
    const response = dialog.showMessageBoxSync(window, {
      type: 'warning',
      buttons: ['Keep Editing', 'Discard Changes'],
      defaultId: 0,
      cancelId: 0,
      title: 'Unsaved Changes',
      message: 'This workspace has unsaved editor changes.',
      detail: 'Discard the changes and continue?',
    });
    if (response === 1) {
      event.preventDefault();
      return;
    }
    pendingWorkspaceRelaunch = undefined;
    continueQuitAfterWindowClose = undefined;
  });
  const openWorkspaceFolder = async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Open Workspace Folder',
      defaultPath: folderPickerDefaultPath,
      properties: ['openDirectory'],
    });
    const selectedPath = result.canceled ? undefined : result.filePaths[0];
    if (!selectedPath) return;
    pendingWorkspaceRelaunch = {
      selectedPath,
      args: withWorkspacePathArg(process.argv.slice(1), selectedPath),
    };
    // Attempt the close unconditionally: the renderer decides whether there is
    // anything to discard, and the will-prevent-unload handler above clears the
    // pending relaunch when the user keeps editing. The replacement is
    // scheduled only from the closed handler, after unsaved changes can no
    // longer cancel it.
    window.close();
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
  // Not fire-and-forget: every quit path reaches the before-quit handler,
  // whose lifecycle drain awaits the dispose queue's idle before the final
  // quit. `desktopDiffHost.dispose()` is invoked synchronously here (so
  // `disposed` flips immediately); the queue only orders when this window's
  // completion promise resolves, keeping a macOS dock-reopen from discarding
  // an earlier window's still-running cleanup.
  windowResources.add(() => {
    const current = desktopDiffHost.dispose().catch(reportBackgroundError);
    void diffHostDisposeQueue.add(() => current);
  });
  const agentExecutionHost: DesktopAgentExecutionHost = {
    openPath: previewHost.openPath,
    openBuildDisplay: previewHost.openBuildDisplay,
    openDiff: desktopDiffHost.openDiff,
    confirmAcceptFile: (message) =>
      confirmDialog({ message, confirmLabel: 'Replace file' }),
    chooseTeamAvailability,
    signInForRemoteAgentCatalog,
    showInfoMessage,
    showWarningMessage,
    showErrorMessage: (message) =>
      showErrorMessage(message).catch(reportBackgroundError),
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
    // Recompute the onboarding funnel after a run completes so a user's first
    // successful run leaves the setup card without waiting for a restart
    // (the run lifecycle has already persisted firstRunDone). Mirrors the
    // extension's post-run refresh hooks in MainViewMessageHandler.
    onRunCompleted: () => {
      void onboardingIpcRef.current?.refreshOnboardingFunnel();
    },
  };
  const agentExecutionOptions: DesktopAgentExecutionOptions = {
    postToRenderer: postToRendererIfAlive,
    host: agentExecutionHost,
    session: options.processSession,
    sessionStores: options.sessionStores,
    resourcesPath: options.resourcesPath,
  };
  let agentExecution: DesktopProgressBridge | undefined;
  let agentExecutionLoad: Promise<DesktopProgressBridge> | undefined;
  // Aborted once the window is closed: the signal is both the presentation
  // cancellation token and this window's "gone" fact.
  const presentationAbort = new AbortController();
  windowResources.add(() => {
    if (agentExecution) {
      agentExecution.dispose();
    } else {
      void agentExecutionLoad
        ?.then((execution) => execution.dispose())
        .catch((error: unknown) => {
          if (!(error instanceof Error && error.name === 'AbortError')) {
            reportBackgroundError(error);
          }
        });
    }
  });
  // Registered after the execution disposer: LIFO disposal aborts first,
  // cancelling an in-flight lazy load.
  windowResources.add(() => presentationAbort.abort());
  const getAgentExecution = async (): Promise<DesktopProgressBridge> => {
    if (agentExecution) return agentExecution;
    if (presentationAbort.signal.aborted) {
      throw new Error(
        'Cannot load desktop agent execution after window close.',
      );
    }

    agentExecutionLoad ??= import('./desktopAgentExecution.js')
      .then(async ({ createDesktopAgentExecution }) => {
        const created = await createDesktopAgentExecution({
          ...agentExecutionOptions,
          presentationSignal: presentationAbort.signal,
        });
        if (presentationAbort.signal.aborted) {
          created.dispose();
          throw new Error(
            'Desktop window closed before agent execution finished loading.',
          );
        }
        agentExecution = created;
        return created;
      })
      .catch((error: unknown) => {
        agentExecutionLoad = undefined;
        throw error;
      });
    return agentExecutionLoad;
  };
  const fileSelection = createDesktopFileSelection({
    postToRenderer: postToRendererIfAlive,
    showOpenFileDialog: async (options) => {
      const result = await dialog.showOpenDialog(window, {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
        properties: options.allowMultiple
          ? ['openFile', 'multiSelections']
          : ['openFile'],
      });
      return result.canceled ? undefined : result.filePaths;
    },
    onError: reportAsyncError,
  });
  const agentSettingsController = new DefaultDesktopAgentSettingsController({
    workspaceState: platform().workspaceState,
    globalState: platform().globalState,
    registry: {
      loadAgents,
      refreshAgents: refresh,
      loadAgentOptionsData: computeAgentOptionsData,
      getAgents: getAgentsByCategory,
      getVisibleAgents,
    },
    directory: {
      getCustomAgentDirectory: () => platform().agentDirectories.custom(),
      getSourceDirectory: (source: AgentSource) => {
        switch (source) {
          case 'custom':
            return platform().agentDirectories.custom();
          case 'builtInWorkflow':
            return platform().agentDirectories.builtIn();
          case 'builtInToolUse':
            return platform().agentDirectories.builtInToolUse();
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
          defaultPath: folderPickerDefaultPath,
          properties: ['openDirectory', 'createDirectory'],
        });
        return result.canceled ? undefined : result.filePaths[0];
      },
      openPath: previewHost.openPath,
      revealPath: async (filePath) => shell.showItemInFolder(filePath),
    },
    renderer: {
      postToRenderer: postToRendererIfAlive,
    },
    prompts: {
      promptText: (input) => promptController.request(input),
      confirm: ({ title, message }) =>
        confirmDialog({ title, message, confirmLabel: 'Continue' }),
      chooseTeamAvailability: ({ presetName, unavailableNames }) =>
        chooseTeamAvailability(unavailableNames, presetName),
    },
    remoteCatalog: {
      canAccess: () => SupabaseClient.isAuthenticated(),
      signIn: signInForRemoteAgentCatalog,
    },
    notifications: { showInfoMessage, showErrorMessage },
    resourcesPath: options.resourcesPath,
  });
  const subscriptionUsage = new SubscriptionUsageService();
  const credentialSettingsController =
    new DefaultDesktopCredentialSettingsController({
      workspaceState: platform().workspaceState,
      globalState: platform().globalState,
      config: platform().config,
      secrets: platform().secrets,
      renderer: {
        postToRenderer: postToRendererIfAlive,
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
      notifications: { showInfoMessage, showWarningMessage, showErrorMessage },
      auth: {
        signIn,
        signOut: () => desktopAuth.signOut(),
      },
      subscriptionUsage,
      onCredentialChanged: async () => {
        await onboardingIpcRef.current?.refreshOnboardingFunnel();
      },
      // Credential operations already show their specific failure dialog. Keep
      // the shared callback log-only so one failure never opens a second,
      // generic desktop-operation dialog.
      onError: reportBackgroundError,
    });
  const toolingSettingsController = new DefaultDesktopToolingSettingsController(
    {
      onError: reportAsyncError,
      workspaceState: platform().workspaceState,
      globalState: platform().globalState,
      renderer: {
        postToRenderer: postToRendererIfAlive,
      },
      dashboard: {
        buildItems: async (cachedResults) => {
          const { buildToolDashboardItems } =
            await import('@controllers/settingsView/ToolDashboardData');
          return buildToolDashboardItems('desktop', cachedResults);
        },
        getCachedCheckResults: async () => {
          const { getLastCheckResults } =
            await import('@tools/toolAvailability');
          return getLastCheckResults() ?? undefined;
        },
        refreshAvailability: async () => {
          const { refreshToolAvailability } =
            await import('@tools/toolAvailability');
          await refreshToolAvailability();
        },
        planTerminalAction: async (toolId, kind) => {
          const { planToolTerminalAction } =
            await import('@controllers/settingsView/ToolDashboardData');
          return planToolTerminalAction({ toolId, commandKind: kind });
        },
      },
      navigation: { openExternal: previewHost.openExternal },
      commands: {
        run: async (command: string) => {
          postToRendererIfAlive({
            command: DESKTOP_WORKSPACE_COMMANDS.TERMINAL_OPEN_COMMAND,
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
      latexConfigPersistenceController: new LatexConfigPersistenceController(),
    },
  );
  const settingsUi: DesktopSettingsUiHost = {
    showInfoMessage,
    showErrorMessage,
    confirmAction: (message, confirmLabel) =>
      confirmDialog({ message, confirmLabel }),
    openPath: previewHost.openPath,
    revealStream: async (streamId) => {
      try {
        const execution = await getAgentExecution();
        return await execution.revealStream(streamId);
      } catch (error) {
        if (!presentationAbort.signal.aborted) reportBackgroundError(error);
        return 'unavailable';
      }
    },
    // Only a live presentation knows a stream's label, so this reads the
    // already-constructed bridge rather than creating one; the Git tab falls
    // back to the raw stream id when no window is attached.
    getStreamLabel: (streamId) => agentExecution?.getStreamLabel(streamId),
    promptForSecret: (input) =>
      promptController.request({ ...input, password: true }),
    // Not previewHost.openExternal: that one shows an error dialog and
    // rethrows a rewrapped error, which this surface's caller does not expect.
    openExternal: async (url) => {
      await shell.openExternal(url);
    },
    onError: reportAsyncError,
  };
  const settingsIpc = createDesktopSettingsIpc({
    postToRenderer: postToRendererIfAlive,
    agentSettingsController,
    credentialSettingsController,
    toolingSettingsController,
    state: {
      globalState: platform().globalState,
      workspaceState: platform().workspaceState,
    },
    config: platform().config,
    ui: settingsUi,
    session: options.processSession,
  });
  settingsIpcRef.current = settingsIpc;
  // Both hold window-scoped subscriptions (goal state and app signals) that
  // would otherwise accumulate one listener per macOS dock reactivation.
  windowResources.add(() => settingsIpc.dispose());
  windowResources.add(() => toolingSettingsController.dispose());
  const progressIpc = createDesktopProgressIpc({
    source: {
      get: () => agentExecution,
      ensure: getAgentExecution,
    },
    onAsyncError: reportAsyncError,
    // A registry entry declared `unsupported(...)` carries a user-facing
    // reason; fall back to a generic message for a truly unrecognized
    // command (a version-skew edge case, not expected in practice).
    onUnsupportedCommand: (message, reason) => {
      void showInfoMessage(
        reason ?? `"${message.command}" is not available in the desktop app.`,
      );
    },
  });
  const onboardingIpc = createDesktopOnboardingIpc(
    { postToRenderer: postToRendererIfAlive },
    {
      // Single source of truth for "does the user have a usable credential",
      // shared by every host (extension, desktop, CLI) so this credential-gating
      // logic can't drift between them.
      hasCredential: () => hasUsableSetupCredential(platform().secrets),
      selectSetupAgent: async () => {
        const entry = getAgent('setup', AgentCategory.ToolUse);
        ipcRef.current?.postToRenderer({
          command: MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT,
          agentId: entry ? agentKeyOf(entry) : 'setup',
          sessionType: 'toolUse' as const,
        });
      },
      // Launch the setup conversation when the user clicks "Run Setup" on the
      // setup card, mirroring the extension's `launchSetupAssistant` →
      // `handleExecute` path: resolve a model the user's credentials can call,
      // build the setup execute message, and run it through the same desktop
      // execute path the renderer's Execute button uses. The per-session
      // `setupKickoffStarted` dedup guard inside the onboarding IPC keeps this
      // one-shot; on a resolution failure it throws so that guard resets and a
      // later "Run Setup" click can retry.
      kickoffSetup: async () => {
        const { buildDesktopSetupExecuteMessage } =
          await import('@controllers/onboarding/setupLaunch');
        const message = await buildDesktopSetupExecuteMessage();
        if (!message) {
          await showErrorMessage(
            'No model is available for your current credentials. Sign in with ChatGPT or add a provider or coding-plan API key in Models, then try setup again.',
          );
          // Throw so the onboarding IPC clears its kickoff guard and a later
          // credential change can re-trigger the auto-start.
          throw new Error('Setup launch: no runnable model resolved.');
        }
        // Idempotent: returns the in-flight/initialized registry so a kickoff
        // racing the startup `loadAgents()` cannot hit "Could not find agent:
        // setup" (mirrors `setupAssistantCommand.launchSetupAssistant`).
        const { loadAgents } = await import('@agent/index');
        await loadAgents();
        const preparation = prepareMainViewExecutionRequest(message);
        if (!preparation.valid) {
          await showErrorMessage(preparation.message);
          throw new Error(preparation.message);
        }
        // Initialize the presentation subscription before launch so a fast
        // terminal result is eligible for replay. This await ends before the
        // process-owned run begins and therefore cannot retain the window for
        // the duration of the run.
        await getAgentExecution();
        return launchDesktopAgent(
          { kind: 'fresh', ...preparation.request },
          {
            session: options.processSession,
          },
        );
      },
      signInWithChatGpt: () => settingsIpc.signInChatGpt(),
      // The desktop shell can't host the VS Code getting-started walkthrough, so
      // the State 0 walkthrough button opens the desktop docs externally — the
      // closest desktop analog, reusing the same docs URL the Help menu's
      // "Desktop Documentation" item opens.
      openGettingStarted: async () => {
        await previewHost.openExternal(DESKTOP_DOCS_URL);
      },
      onAsyncError: reportAsyncError,
    },
  );
  onboardingIpcRef.current = onboardingIpc;
  // Git reads re-probe the active workspace per request, so workspace
  // switches don't need cache invalidation. Both lambdas map a missing
  // workspace to the host's empty-result convention.
  const getRecentCommits = async () => {
    const workspacePath = options.workspacePath;
    if (!workspacePath) {
      return { commits: [] as string[], isGitRepo: false };
    }
    return readRecentCommits(workspacePath, DESKTOP_RECENT_COMMIT_LIMIT, {
      onError: reportBackgroundError,
    });
  };
  const getEnvironmentSummary = async () => {
    const workspacePath = options.workspacePath;
    if (!workspacePath) {
      return EMPTY_DESKTOP_ENVIRONMENT_SUMMARY;
    }
    return (
      (await readGitEnvironmentSummary(workspacePath, {
        onError: reportBackgroundError,
      })) ?? EMPTY_DESKTOP_ENVIRONMENT_SUMMARY
    );
  };
  const shellActions = createDesktopShellActions(
    { postToRenderer: postToRendererIfAlive },
    {
      getCustomAgentDirectory: () => platform().agentDirectories.custom(),
      openExternalUrl: previewHost.openExternal,
      openLogFolder: () => previewHost.openPath(getDesktopLogDirectory()),
      openPath: previewHost.openPath,
      openWorkspaceFolder,
      signIn,
      getRecentCommits,
      showInfoMessage,
      onAsyncError: reportAsyncError,
    },
  );
  // Interactive terminals and embedded browser tabs. Both stream to the
  // renderer through the IPC bridge installed just below, so they post via
  // `ipcRef.current` rather than capturing a bridge that doesn't exist yet.
  const ptyHost = createDesktopPtyHost({
    cwd: options.workspacePath,
    onData: (sessionId, data) =>
      postToRendererIfAlive({
        command: DESKTOP_WORKSPACE_COMMANDS.TERMINAL_DATA,
        sessionId,
        data,
      }),
    onExit: (sessionId, exitCode) =>
      postToRendererIfAlive({
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
      postToRendererIfAlive({
        command: DESKTOP_WORKSPACE_COMMANDS.BROWSER_STATE,
        ...state,
      }),
    onError: reportAsyncError,
    onBlockedExternalUrl: reportBackgroundError,
    onExternalOpenError: reportBackgroundError,
  });
  const workspaceIpc = createDesktopWorkspaceIpc(
    { postToRenderer: postToRendererIfAlive },
    {
      ptyHost,
      browserViews,
      // The renderer measures the browser slot in CSS pixels relative to its
      // own viewport; a WebContentsView is positioned in the window's
      // device-independent content space. These coincide at zoom factor 1, so
      // scale by the renderer's zoom to keep the view aligned when the user
      // has zoomed the UI.
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
      getEnvironmentSummary,
      onAsyncError: reportAsyncError,
    },
  );
  // Shells keep running and web contents keep loading unless explicitly torn
  // down — neither is reachable once the window is gone.
  windowResources.add(() => workspaceIpc.disposeRendererResources());
  // Separate from the renderer teardown above, which also runs on renderer
  // reload: the app-signal subscription must survive a reload and die with the
  // window, or macOS dock reactivation would stack one listener per reopen.
  windowResources.add(() => workspaceIpc.dispose());
  let initialRendererNavigationComplete = false;
  window.webContents.on('did-navigate', () => {
    if (!initialRendererNavigationComplete) {
      initialRendererNavigationComplete = true;
      return;
    }
    // A fresh renderer has its own terminal IDs and browser-tab layout. Tear
    // down the previous document's main-process resources before those IDs can
    // be reused or an old WebContentsView can cover the new page.
    workspaceIpc.disposeRendererResources();
  });
  const mainViewIpc = installDesktopMainViewIpc(window, {
    workspace: workspaceIpc,
    handleExecuteMessage: async (message) => {
      const execution = await getAgentExecution();
      void execution.handleExecute(message).catch(reportAsyncError);
    },
    fileSelection,
    prompt: promptController,
    settings: settingsIpc,
    progress: progressIpc,
    onboarding: onboardingIpc,
    globalState: platform().globalState,
    logs: {
      readLog: () =>
        readDesktopLogSnapshot({ workspacePath: options.workspacePath }),
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
    },
    shellActions,
    getAuthStatus: async () => ({
      authenticated: await SupabaseClient.isAuthenticated(),
    }),
    onAsyncError: reportAsyncError,
  });
  ipcRef.current = mainViewIpc;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(buildDesktopMenuTemplate(shellActions)),
  );
  window.once('closed', () => {
    // Read, never cleared: `window-all-closed` fires after this handler and
    // must still see the relaunch so it defers quitting to the branch below.
    const workspaceRelaunch = pendingWorkspaceRelaunch;
    const continueQuit = continueQuitAfterWindowClose;
    continueQuitAfterWindowClose = undefined;
    try {
      windowResources.dispose();
    } catch (error) {
      reportBackgroundError(error);
    }
    if (mainWindow === window) {
      mainWindow = null;
      if (process.platform === 'darwin') {
        Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }]));
      }
    }
    if (workspaceRelaunch) {
      void (async () => {
        try {
          await platform().globalState.update(
            DESKTOP_WORKSPACE_PATH_STATE_KEY,
            workspaceRelaunch.selectedPath,
          );
        } catch (error) {
          reportBackgroundError(error);
        }
        // Consumed. The synchronous `window-all-closed` in this same turn has
        // already seen the pending value and deferred quitting; clearing here
        // stops a later window's closed handler (macOS dock reactivation
        // during the drain) from scheduling a second relaunch.
        if (pendingWorkspaceRelaunch === workspaceRelaunch) {
          pendingWorkspaceRelaunch = undefined;
        }
        // The development supervisor owns Vite and the Electron child. Let it
        // replace the child so the new process keeps a live renderer URL.
        if (
          process.env.TEXRA_DESKTOP_DEV_SUPERVISED === '1' &&
          typeof process.send === 'function'
        ) {
          process.send(workspaceRelaunch.args);
        } else {
          app.relaunch({ args: workspaceRelaunch.args });
        }
        // Use the lifecycle-aware path so the process session drains before
        // Electron starts the replacement process.
        app.quit();
      })();
    } else {
      continueQuit?.();
    }
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

if (protocolLifecycle.shouldContinue) {
  app
    .whenReady()
    .then(async () => {
      const processResumeOwner = new DesktopProcessResumeOwner();
      const platformInit = await initializeElectronPlatform(
        desktopMainDir,
        processResumeOwner,
      );
      const { lifecycle } = platformInit;
      // A broken transcript directory must not reject whenReady: degrade to
      // an in-memory store and warn once the window exists, exactly as the
      // CLI TUI does. The degraded session also cannot resume — nothing is
      // persisted for a later launch to pick up, and `SessionHandle` skips
      // restart repair on a non-persistent store.
      const transcripts = await StreamLogStore.openOrEphemeral();
      const processSession = new SessionHandle({
        transcripts,
        restartRepair: 'deferred',
        responseTextProcessing: createTexraResponseTextProcessing(
          agentResponseTextConnector,
        ),
      });
      const detachTerminalResultToast = attachTerminalResultToast(
        processSession,
        processSession.interactions,
        { replayWhenAttached: true },
      );
      // Fill-later slot for the process-resume attachment made below: the
      // BEFORE drain detaches it first (before agent shutdown), and the
      // idempotent store makes the ON-phase repeat a no-op.
      const agentResumeHandler = new DisposableStore();
      // Process root: session-lifetime resources register at creation and are
      // disposed LIFO in the ON phase (process stores → result toast →
      // session).
      const processResources = new DisposableStore();
      processResources.add(() => processSession.dispose());
      processResources.add(detachTerminalResultToast);
      let sessionStores!: SessionStores;
      lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
        agentResumeHandler.dispose(),
      );
      registerAgentShutdownHandlers(lifecycle);
      lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () => killActiveRecording());
      // Agent shutdown runs first so its final events enter the process-owned
      // stores. Flush in BEFORE so persistence cannot be delayed by a later
      // ON-phase language-service disposal.
      lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
        processSession.flushArtifacts(),
      );
      // Each window's closed handler starts diff temp-dir removal before the
      // quit lifecycle drains; awaiting the queue's idle here keeps the
      // process alive until the directories are actually gone.
      lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
        diffHostDisposeQueue.onIdle(),
      );
      // First ON handler: every BEFORE handler above has had its turn at the
      // runs it owns, so this settles what quitting left mid-run — a durable
      // CANCELLED outcome and a released lease instead of a record the next
      // launch has to repair — before the disposal below.
      lifecycle.onShutdown(SHUTDOWN_PHASE.ON, (signal) =>
        settleLiveSessionExecutions(signal),
      );
      lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () => {
        agentResumeHandler.dispose();
        processResources.dispose();
      });

      // Until the initial window is fully wired, any startup failure must run
      // the same process-session shutdown used by an ordinary application
      // exit. Once this block completes, the lifecycle owns that cleanup.
      try {
        const processStores =
          await initializeDesktopProcessStores(processSession);
        processResources.add(() => processStores.dispose());
        await processSession.waitUntilReady();
        processSession.setApprovalPolicy(
          readPersistedTexraApprovalPolicy((key, fallback) =>
            platform().config.get(key, fallback),
          ),
        );
        sessionStores = processStores.stores;
        agentResumeHandler.add(
          processResumeOwner.attach({ session: processSession }),
        );
        // Ask the renderer to close before draining process services. A dirty
        // editor can veto that close and remain fully operational. Once the
        // window really closes, its handler calls app.quit() again and this
        // listener proceeds with the ordinary shutdown chain.
        let shutdownStarted = false;
        let quitting = false;
        app.on('before-quit', (event) => {
          if (quitting) return;
          if (mainWindow && !mainWindow.isDestroyed()) {
            event.preventDefault();
            continueQuitAfterWindowClose = () => app.quit();
            mainWindow.close();
            return;
          }
          event.preventDefault();
          if (shutdownStarted) return;
          shutdownStarted = true;
          void lifecycle.runShutdown().finally(() => {
            quitting = true;
            app.quit();
          });
        });

        void initializeDesktopCrashReporting({
          sensitivePaths: [
            platformInit.workspacePath,
            app.getPath('userData'),
            platformInit.dataRoot,
          ],
          log: console,
        });
        const authCoordinator = createDesktopAuthCoordinator({
          secrets: platform().secrets,
          log: console,
        });
        const authCallbackState = createDesktopAuthCallbackState(
          console,
          platform().globalState,
        );
        installContentSecurityPolicy();
        reopenMainWindow = () =>
          createWindow({
            workspacePath: platformInit.workspacePath,
            authCoordinator,
            authCallbackState,
            processSession,
            sessionStores,
            resourcesPath: platformInit.resourcesPath,
          });
        reopenMainWindow();
        if (transcripts.mode.kind === 'ephemeral') {
          void showDesktopWarningDialog(
            ephemeralTranscriptWarning(transcripts.mode.reason),
          ).catch((error: unknown) => console.error(error));
        }

        app.on('activate', () => {
          if (BrowserWindow.getAllWindows().length === 0) reopenMainWindow?.();
        });
      } catch (error) {
        await lifecycle.runShutdown();
        throw error;
      }
    })
    .catch((error: unknown) => {
      reportFatalStartupError(error);
    });
}

app.on('window-all-closed', () => {
  if (pendingWorkspaceRelaunch) return;
  if (process.platform !== 'darwin') app.quit();
});
