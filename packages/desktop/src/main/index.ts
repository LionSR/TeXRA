import { existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs';
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

import type { SessionStores } from '@agent/storage';
import {
  computeAgentOptionsData,
  getAgent,
  getAgentsByCategory,
  getVisibleAgents,
  loadAgents,
  refresh,
} from '@agent/index/agentRegistry';
import { registerAgentShutdownHandlers } from '@agent/runtime/agentShutdown';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import { attachTerminalResultToast } from '@agent/runtime/terminalResultToast';
import { getServerSideKeyService } from '@auth/serverKeys';
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
import type { TerminalRunResult } from '@hosts/uiHosts';
import { hasUsableSetupCredential } from '@model/setupCredentialAccess';
import { platform } from '@platform/platform';
import { SHUTDOWN_PHASE } from '@platform/interfaces';
import { RUNS_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { normalizePlatform } from '@shared/constants/latex';
import {
  AgentCategory,
  agentKeyOf,
  type AgentSource,
} from '@shared/schemas/agent';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { backfillFirstRunDone } from '@shared/state/onboardingState';
import { StreamLogStore } from '@transcript';
import { debounce } from '@utils/core';
import { DEBOUNCE_OPTIONS_MS } from '@utils/config/constants';
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
import { DESKTOP_WORKSPACE_COMMANDS } from '../desktopWorkspaceMessages.js';
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
import { refreshDesktopModelListStateIfNeeded } from './desktopModelListRefresh.js';
import { DesktopPromptController } from './desktopPromptController.js';
import { createDesktopProgressIpc } from './desktopProgressIpc.js';
import { DefaultDesktopAgentSettingsController } from './desktopAgentSettingsController.js';
import { DefaultDesktopCrashReportingSettingsController } from './desktopCrashReportingSettingsController.js';
import { DefaultDesktopCredentialSettingsController } from './desktopCredentialSettingsController.js';
import { DesktopHistoryHandlers } from './desktopHistoryHandlers.js';
import {
  createDesktopSettingsIpc,
  type DesktopSettingsUiHost,
} from './desktopSettingsIpc.js';
import {
  buildDefaultToolDashboardItems,
  findToolCommand,
  getCachedToolCheckResults,
  refreshDefaultDisabledToolCache,
  refreshDefaultToolAvailability,
} from './desktopSettingsIpcHelpers.js';
import { DefaultDesktopToolingSettingsController } from './desktopToolingSettingsController.js';
import { createDesktopGitHost } from './desktopGitHost.js';
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
import {
  buildDesktopMenuTemplate,
  DESKTOP_DOCS_URL,
} from '../desktopCommandSurface.js';
import { reportFatalStartupError } from './fatalStartupError.js';
import { installDesktopMainViewIpc } from './mainViewIpc.js';
import { initializeDesktopCrashReporting } from './desktopCrashReporting.js';
import { initializeElectronPlatform } from './platform/index.js';
import {
  DESKTOP_WORKSPACE_PATH_STATE_KEY,
  serializeWorkspacePresenceArg,
  withWorkspacePathArg,
} from '../workspacePath.js';
import type {
  DesktopAgentExecutionOptions,
  DesktopProgressBridge,
} from './desktopAgentExecution.js';
import type { DesktopAgentExecutionHost } from './desktopAgentExecutionHost.js';

const moduleDirname = fileURLToPath(new URL('.', import.meta.url));
const desktopMainDir = findDesktopMainDir(moduleDirname);
let mainWindow: BrowserWindow | null = null;
let reopenMainWindow: (() => void) | undefined;
let workspaceRelaunchInProgress = false;
let continueQuitAfterWindowClose: (() => void) | undefined;

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
  initializeCrashReporting: () => Promise<void>;
  processSession: SessionHandle;
  sessionStores: SessionStores;
  /**
   * Captured in `initializeElectronPlatform` BEFORE the bundled-agent sync
   * writes LAST_KNOWN_VERSION, so the onboarding backfill can tell a returning
   * veteran from a fresh install. See ElectronPlatformInitResult.hasPriorInstall.
   */
  hasPriorInstall: boolean;
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
  const disposeWindowTitle = installDesktopWindowTitle(
    window,
    options.processSession,
    options.workspacePath,
  );
  const reportAsyncError = (error: unknown) => console.error(error);
  installDesktopNavigationPolicy(window.webContents, {
    onAsyncError: reportAsyncError,
  });
  const modelListRefresh = refreshDesktopModelListStateIfNeeded({
    onError: reportAsyncError,
  });
  const ipcRef: {
    current?: ReturnType<typeof installDesktopMainViewIpc>;
  } = {};
  const promptController = new DesktopPromptController({
    postToRenderer: (message) => {
      const ipc = ipcRef.current;
      if (!ipc || window.isDestroyed() || window.webContents.isDestroyed()) {
        return false;
      }
      ipc.postToRenderer(message);
      return true;
    },
  });
  const settingsIpcRef: {
    current?: ReturnType<typeof createDesktopSettingsIpc>;
  } = {};
  const onboardingIpcRef: {
    current?: DesktopOnboardingIpc;
  } = {};
  // Single source of truth for "does the user have a usable credential",
  // shared by every host (extension, desktop, CLI) so this credential-gating
  // logic can't drift between them.
  const probeCredential = async (): Promise<boolean> =>
    hasUsableSetupCredential(platform().secrets);
  const showErrorMessage = async (message: string) => {
    await dialog.showMessageBox(window, { message, type: 'error' });
  };
  const showInfoMessage = async (message: string) => {
    await dialog.showMessageBox(window, { type: 'info', message });
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
  // Lightweight update check (issue #7682, arm b): at most once/day, notifies
  // at most once per release via a native dialog linking to the GitHub
  // release page. Not a full updater — no download, no install, no feed
  // files. Disable with TEXRA_NO_UPDATE_CHECK=1. Gated on owning the
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
    }).catch(reportAsyncError);
  }
  // `installDesktopHostBridge.postToRenderer` is itself a no-op when
  // `webContents.isDestroyed()`. Without checking that here too, callers would
  // falsely report success and skip their external-viewer fallback. Bot
  // review (#3816) caught it. Shared by the preview host and agent-execution
  // wiring below; the diff host keeps its own narrower check (no
  // `webContents.isDestroyed()`) per bot review #3815, so it is not folded in.
  const postToRendererIfAlive = (message: unknown): boolean => {
    const ipc = ipcRef.current;
    if (!ipc || window.isDestroyed() || window.webContents.isDestroyed()) {
      return false;
    }
    ipc.postToRenderer(message);
    return true;
  };
  /**
   * Fire-and-forget post for controllers that don't act on delivery. The
   * bridge's own `webContents.isDestroyed()` no-op (see above) is the guard
   * here; only callers that branch on delivery need
   * {@link postToRendererIfAlive}.
   */
  const postToRenderer = (message: unknown): void => {
    ipcRef.current?.postToRenderer(message);
  };
  const runSetupCommand = async (command: string): Promise<void> => {
    postToRenderer({
      command: DESKTOP_WORKSPACE_COMMANDS.TERMINAL_OPEN_COMMAND,
      initialCommand: command,
    });
  };
  const previewHost = createDesktopPreviewHost({
    shell,
    showErrorMessage,
    // Audit item B / trajectory #17: prefer the in-app PDF overlay
    // (<iframe> mounted inside a wa-dialog so Electron's bundled
    // Chromium PDF viewer renders the build output). The external
    // viewer (`shell.openPath`) is preserved as a fallback when
    // `postToRenderer` is unavailable or the renderer rejects the
    // post — mirrors the diff-host wiring just above.
    //
    // Return `false` when the IPC bridge is not yet wired (startup
    // race) or the BrowserWindow has been destroyed; the host then
    // falls back to the external viewer so previews never silently
    // disappear.
    postToRenderer: postToRendererIfAlive,
  });
  let teamSignInPending = false;
  const refreshDesktopAuthSurfaces = async () => {
    const authenticated = await SupabaseClient.isAuthenticated();
    ipcRef.current?.postToRenderer({
      command: authenticated
        ? MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER
        : MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER,
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
  const desktopAuth = createDesktopSupabaseAuth({
    router: protocolLifecycle.router,
    coordinator: options.authCoordinator,
    oauthClient: SupabaseClient.getClient(),
    callbackState: options.authCallbackState,
    host: desktopAuthHost,
    log: console,
  });
  const signInForRemoteAgentCatalog = async (): Promise<boolean> => {
    teamSignInPending = true;
    try {
      return (
        (await desktopAuth.signInAndWaitForSession()) &&
        (await SupabaseClient.canAccessRemoteAgentCatalog())
      );
    } finally {
      teamSignInPending = false;
    }
  };
  initializeDesktopSetupAuth();
  const setupSignInRegistration = registerDesktopSetupSignIn(
    signInForRemoteAgentCatalog,
  );
  const folderPickerDefaultPath = options.workspacePath ?? app.getPath('home');
  let editorHasUnsavedChanges = false;
  let allowNextPreventedUnload = false;
  let pendingWorkspaceRelaunch:
    { selectedPath: string; args: string[] } | undefined;
  const confirmDiscardUnsavedEditorChanges = (force = false): boolean => {
    if (!force && !editorHasUnsavedChanges) return true;
    const response = dialog.showMessageBoxSync(window, {
      type: 'warning',
      buttons: ['Keep Editing', 'Discard Changes'],
      defaultId: 0,
      cancelId: 0,
      title: 'Unsaved Changes',
      message: 'This workspace has unsaved editor changes.',
      detail: 'Discard the changes and continue?',
    });
    if (response !== 1) return false;
    editorHasUnsavedChanges = false;
    return true;
  };
  window.webContents.on('will-prevent-unload', (event) => {
    if (allowNextPreventedUnload) {
      allowNextPreventedUnload = false;
      event.preventDefault();
      return;
    }
    // The event itself is authoritative: it is emitted only after the
    // renderer observes a dirty Monaco buffer and refuses the unload. The
    // mirrored IPC flag may still be in flight.
    if (confirmDiscardUnsavedEditorChanges(true)) {
      event.preventDefault();
      return;
    }
    pendingWorkspaceRelaunch = undefined;
    workspaceRelaunchInProgress = false;
    continueQuitAfterWindowClose = undefined;
  });
  const openLogsFolder = async () =>
    previewHost.openPath(getDesktopLogDirectory());
  const openWorkspaceFolder = async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Open Workspace Folder',
      defaultPath: folderPickerDefaultPath,
      properties: ['openDirectory'],
    });
    const selectedPath = result.canceled ? undefined : result.filePaths[0];
    if (!selectedPath) return;
    const hadUnsavedChanges = editorHasUnsavedChanges;
    if (!confirmDiscardUnsavedEditorChanges()) return;
    allowNextPreventedUnload = hadUnsavedChanges;
    pendingWorkspaceRelaunch = {
      selectedPath,
      args: withWorkspacePathArg(process.argv.slice(1), selectedPath),
    };
    workspaceRelaunchInProgress = true;
    // Closing first lets the renderer's authoritative beforeunload check veto
    // the switch. The replacement is scheduled only from the closed handler,
    // after unsaved changes can no longer cancel it.
    window.close();
  };
  attachRendererConsoleLog(window.webContents);
  const agentExecutionHost: DesktopAgentExecutionHost = {
    openPath: previewHost.openPath,
    openBuildDisplay: previewHost.openBuildDisplay,
    openDiff: createDesktopDiffHost({
      openPath: previewHost.openPath,
      // Audit item C / trajectory #18: prefer the in-app overlay
      // (<texra-diff-view> inside a wa-dialog). The external-editor
      // path is preserved as a fallback when `postToRenderer` is
      // unavailable or `forceExternal` is set.
      //
      // Return `false` when the IPC bridge is not yet wired (startup
      // race) or the BrowserWindow has been destroyed — the host then
      // falls back to the external-editor flow so diffs never silently
      // disappear. Bot review (#3815): the previous arrow form
      // silently no-op'd on `ipcRef.current === undefined`.
      postToRenderer: (message) => {
        const ipc = ipcRef.current;
        if (!ipc) return false;
        if (window.isDestroyed()) return false;
        ipc.postToRenderer(message);
        return true;
      },
    }).openDiff,
    confirmAcceptFile: async (message) => {
      const result = await dialog.showMessageBox(window, {
        type: 'warning',
        message,
        buttons: ['Yes', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      });
      return result.response === 0;
    },
    chooseTeamAvailability: (unavailableNames) =>
      chooseTeamAvailability(unavailableNames),
    signInForRemoteAgentCatalog,
    showInfoMessage,
    showErrorMessage,
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
  };
  let agentExecution: DesktopProgressBridge | undefined;
  let agentExecutionLoad: Promise<DesktopProgressBridge> | undefined;
  let windowClosed = false;
  const presentationAbort = new AbortController();
  const getAgentExecution = async (): Promise<DesktopProgressBridge> => {
    if (agentExecution) return agentExecution;
    if (windowClosed) {
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
        if (windowClosed) {
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
    postToRenderer,
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
  // Workspace-explorer sidebar removed in PR 3 (PRD § 7.D + § 8). File staging
  // happens entirely inside <main-app>'s built-in panel; the duplicate tree
  // sidebar and its IPC are gone.
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
          case 'remote':
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
      revealPath: async (filePath) => {
        shell.showItemInFolder(filePath);
      },
    },
    renderer: {
      postToRenderer,
    },
    prompts: {
      promptText: (input) => promptController.request(input),
      confirm: async ({ title, message }) => {
        const result = await dialog.showMessageBox(window, {
          type: 'warning',
          title,
          message,
          buttons: ['Continue', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
        });
        return result.response === 0;
      },
      chooseTeamAvailability: ({ presetName, unavailableNames }) =>
        chooseTeamAvailability(unavailableNames, presetName),
    },
    remoteCatalog: {
      canAccess: () => SupabaseClient.canAccessRemoteAgentCatalog(),
      signIn: signInForRemoteAgentCatalog,
    },
    notifications: { showInfoMessage, showErrorMessage },
    resourcesPath: options.resourcesPath,
  });
  const credentialSettingsController =
    new DefaultDesktopCredentialSettingsController({
      workspaceState: platform().workspaceState,
      globalState: platform().globalState,
      config: platform().config,
      secrets: platform().secrets,
      renderer: {
        postToRenderer,
      },
      prompt: {
        input: (input) =>
          promptController.request({
            title: input.title ?? input.prompt ?? 'Set API key',
            prompt: input.prompt ?? 'Enter API key',
            password: input.password,
          }),
        confirm: async (message, promptOptions) => {
          const result = await dialog.showMessageBox(window, {
            type: 'warning',
            message,
            detail: promptOptions?.detail,
            buttons: [promptOptions?.confirmLabel ?? 'OK', 'Cancel'],
            defaultId: 0,
            cancelId: 1,
          });
          return result.response === 0;
        },
      },
      externalOpener: {
        openExternal: previewHost.openExternal,
        presentChatGptSignInUrl: async (url) => {
          const result = await dialog.showMessageBox(window, {
            type: 'info',
            message: 'Signing in with ChatGPT',
            detail:
              'Opened your default browser. Using a different browser for ChatGPT? ' +
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
      },
      notifications: { showInfoMessage, showErrorMessage },
      auth: {
        signIn: () => desktopAuth.signIn(),
        signOut: () => desktopAuth.signOut(),
      },
      setUseIncludedModelAccess: (enabled) =>
        getServerSideKeyService().setUseIncludedModelAccess(enabled),
      modelListRefresh,
      onCredentialChanged: async () => {
        await onboardingIpcRef.current?.refreshOnboardingFunnel();
      },
      onError: reportAsyncError,
    });
  const presentExtensionInstall = async (extensionId: string) => {
    // TeXRA Desktop cannot host VS Code extensions. This action explicitly
    // offers navigation to the VS Code marketplace or the extension id.
    const result = await dialog.showMessageBox(window, {
      type: 'info',
      message: 'VS Code extension referenced',
      detail:
        `${extensionId}\n\n` +
        'TeXRA Desktop runs standalone and cannot host VS Code extensions. ' +
        'If you also use VS Code, you can install this extension there.',
      buttons: ['Open in Marketplace', 'Copy ID', 'Close'],
      defaultId: 0,
      cancelId: 2,
    });
    if (result.response === 0) {
      await previewHost.openExternal(
        `https://marketplace.visualstudio.com/items?itemName=${encodeURIComponent(extensionId)}`,
      );
    } else if (result.response === 1) {
      clipboard.writeText(extensionId);
    }
  };
  const toolingSettingsController = new DefaultDesktopToolingSettingsController(
    {
      onError: reportAsyncError,
      workspaceState: platform().workspaceState,
      globalState: platform().globalState,
      renderer: {
        postToRenderer,
      },
      dashboard: {
        buildItems: buildDefaultToolDashboardItems,
        getCachedCheckResults: getCachedToolCheckResults,
        refreshAvailability: refreshDefaultToolAvailability,
        refreshDisabledCache: refreshDefaultDisabledToolCache,
        findCommand: findToolCommand,
      },
      navigation: {
        openExternal: previewHost.openExternal,
        presentExtensionInstall,
      },
      commands: { run: runSetupCommand },
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
        onDetectionError: reportAsyncError,
      }),
      latexConfigPersistenceController: new LatexConfigPersistenceController(),
    },
  );
  const crashReportingSettingsController =
    new DefaultDesktopCrashReportingSettingsController({
      state: platform().globalState,
      secrets: platform().secrets,
      renderer: {
        postToRenderer,
      },
      prompt: {
        input: (input) =>
          promptController.request({ ...input, password: true }),
      },
      initialization: { initialize: options.initializeCrashReporting },
    });
  const settingsUi: DesktopSettingsUiHost = {
    showInfoMessage,
    showErrorMessage,
    confirmAction: async (message, confirmLabel = 'OK') => {
      const result = await dialog.showMessageBox(window, {
        type: 'warning',
        message,
        buttons: [confirmLabel, 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      });
      return result.response === 0;
    },
    openPath: previewHost.openPath,
    revealStream: async (streamId) => {
      try {
        const execution = await getAgentExecution();
        await execution.revealStream(streamId);
      } catch (error) {
        if (!windowClosed) reportAsyncError(error);
      }
    },
    // Only a live presentation knows a stream's label, so this reads the
    // already-constructed bridge rather than creating one; the Git tab falls
    // back to the raw stream id when no window is attached.
    getStreamLabel: (streamId) => agentExecution?.getStreamLabel(streamId),
    promptForSecret: (input) =>
      promptController.request({ ...input, password: true }),
    openExternal: async (url) => {
      await shell.openExternal(url);
    },
    onError: reportAsyncError,
  };
  const historySettingsController = new DesktopHistoryHandlers({
    resourcesPath: options.resourcesPath,
    postToRenderer,
    // Rerun and restore use the same host-neutral owners as the extension,
    // reached through the desktop execution bridge instead of VS Code commands.
    runExecution: (request) =>
      getAgentExecution().then((execution) => execution.runExecution(request)),
    restoreTaskState: async (taskState) =>
      (await getAgentExecution()).restoreTaskState(taskState),
    openPath: settingsUi.openPath,
    showInfoMessage: settingsUi.showInfoMessage,
    showErrorMessage: settingsUi.showErrorMessage,
    onError: settingsUi.onError,
  });
  // Cross-host history refresh (#8625): the shared ~/.texra executions dir
  // is written by the CLI and extension too, so the settings history list
  // re-posts when any host adds, finishes, or deletes a run. Best-effort: a
  // watch failure only disables live refresh; manual refresh still works.
  const executionsDir = join(
    platform().storage.getStoragePath(),
    RUNS_STORAGE_DIR,
  );
  const debouncedHistoryRepost = debounce(async () => {
    try {
      if (windowClosed) return;
      await historySettingsController.postHistoryData();
    } catch (error) {
      reportAsyncError(error);
    }
  }, DEBOUNCE_OPTIONS_MS);
  let executionsWatcher: FSWatcher | undefined;
  try {
    mkdirSync(executionsDir, { recursive: true });
    executionsWatcher = watch(executionsDir, { recursive: true }, () => {
      void debouncedHistoryRepost();
    });
  } catch (error) {
    reportAsyncError(error);
  }
  const settingsIpc = createDesktopSettingsIpc({
    postToRenderer,
    agentSettingsController,
    crashReportingSettingsController,
    credentialSettingsController,
    historySettingsController,
    toolingSettingsController,
    state: {
      globalState: platform().globalState,
      workspaceState: platform().workspaceState,
    },
    config: platform().config,
    ui: settingsUi,
  });
  settingsIpcRef.current = settingsIpc;
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
  // Opened once the one-shot backfill below has settled. The onboarding IPC
  // awaits this before its first funnel derivation so a returning veteran
  // (credential present, `firstRunDone` not yet written) can't have WEBVIEW_READY
  // transiently derive State 1 — firing `selectSetupAgent` and clobbering the
  // launcher's agent selection — before the backfill marks them `done`.
  let openOnboardingReadyGate: () => void = () => {};
  const onboardingReadyGate = new Promise<void>((resolve) => {
    openOnboardingReadyGate = resolve;
  });
  const onboardingIpc = createDesktopOnboardingIpc(
    { postToRenderer },
    {
      hasCredential: probeCredential,
      readyGate: onboardingReadyGate,
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
            'No model is available for your current credentials. Sign in with ChatGPT, add a provider API key, or check your Researcher Access tier, then try setup again.',
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
        return launchDesktopAgent(preparation.request, {
          session: options.processSession,
        });
      },
      signInWithChatGpt: async () => {
        // Welcome-card sign-in enables ChatGPT subscription routing so the
        // funnel recognises the new credential instead of bouncing back to
        // `needs-credential`.
        await settingsIpc.signInChatGpt({ enableSubscription: true });
      },
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
  // One-shot migration: existing desktop users with a credential or run
  // history never see the welcome card (State 0) or setup auto-start (State
  // 1). Mirrors the extension (`extension.ts:282`) and CLI
  // (`runOnboarding.tsx:154`) backfill, which desktop formerly skipped by
  // hardcoding `'done'`.
  void (async () => {
    try {
      const globalState = platform().globalState;
      // Gate the whole probe + backfill on the flag being unwritten, so the
      // credential/relay/`listExecutions` I/O only runs once (first launch
      // after upgrade) rather than on every window creation.
      if (
        globalState.get<boolean | undefined>(
          GlobalStateKey.ONBOARDING_FIRST_RUN_DONE,
        ) !== undefined
      ) {
        return;
      }
      const hasCredential = await probeCredential().catch(() => false);
      // `options.hasPriorInstall` was read in `initializeElectronPlatform`
      // BEFORE the bundled-agent sync wrote LAST_KNOWN_VERSION during this same
      // session. Reading the key here instead would always be defined (the sync
      // already ran and is awaited before createWindow), wrongly classifying a
      // fresh credentialed user as a veteran → 'done', so State 1 never shows.
      const hasPriorInstall = options.hasPriorInstall;
      // Inline `listExecutions` import so the agent storage module tree-shakes
      // from the desktop main bundle unless we actually reach the backfill
      // path on the first launch.
      const { listExecutions } = await import('@agent/storage');
      const hasRunHistory = await listExecutions()
        .then((entries) => entries.length > 0)
        .catch(() => false);
      await backfillFirstRunDone(globalState, {
        hasCredential,
        hasPriorInstall,
        hasRunHistory,
      });
    } catch {
      // Swallow — backfill failure must not block window creation.
    } finally {
      // Open the gate (whether we backfilled or early-returned) so the
      // onboarding IPC's gated first refresh — driven by WEBVIEW_READY — derives
      // the settled post-backfill state. That gated refresh covers both mount
      // orders (webview before or after backfill), so no separate post-backfill
      // refresh is issued here: a premature one could run before the renderer is
      // listening and consume the one-time selectSetupAgent transition, leaving
      // the launcher on the default agent while the setup card is shown.
      openOnboardingReadyGate();
    }
  })();
  // Real desktop git host — closes audit item A from
  // `docs/dev/audits/2026-05-08-standalone-trajectory-audit.md` (trajectory #16). Spawns
  // `git log` under the active workspace to populate the launcher banner's
  // recent-commits picker. The host is stateless and re-probes per request,
  // so workspace switches don't need cache invalidation.
  const gitHost = createDesktopGitHost({
    getWorkspacePath: () => options.workspacePath,
    onError: reportAsyncError,
  });
  const shellActions = createDesktopShellActions(
    { postToRenderer },
    {
      getCustomAgentDirectory: () => platform().agentDirectories.custom(),
      openExternalUrl: previewHost.openExternal,
      openLogFolder: openLogsFolder,
      openPath: previewHost.openPath,
      openWorkspaceFolder,
      signIn: () => desktopAuth.signIn(),
      getRecentCommits: () => gitHost.getRecentCommits(),
      showInfoMessage,
      onAsyncError: reportAsyncError,
    },
  );
  // Interactive terminals and embedded browser tabs. Both stream to the
  // renderer through the IPC bridge installed just below, so they post via
  // `ipcRef.current` rather than capturing a bridge that doesn't exist yet.
  const postWorkspaceMessage = (message: unknown): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    ipcRef.current?.postToRenderer(message);
  };
  const ptyHost = createDesktopPtyHost({
    cwd: options.workspacePath,
    onData: (sessionId, data) =>
      postWorkspaceMessage({
        command: DESKTOP_WORKSPACE_COMMANDS.TERMINAL_DATA,
        sessionId,
        data,
      }),
    onExit: (sessionId, exitCode) =>
      postWorkspaceMessage({
        command: DESKTOP_WORKSPACE_COMMANDS.TERMINAL_EXIT,
        sessionId,
        exitCode,
      }),
    onError: reportAsyncError,
  });
  const browserViews = createDesktopBrowserViews({
    getWindow: () => (window.isDestroyed() ? undefined : window),
    openExternalUrl: (url) => previewHost.openExternal(url),
    onNavigated: (state) =>
      postWorkspaceMessage({
        command: DESKTOP_WORKSPACE_COMMANDS.BROWSER_STATE,
        ...state,
      }),
    onError: reportAsyncError,
  });
  const workspaceIpc = createDesktopWorkspaceIpc(
    { postToRenderer: postWorkspaceMessage },
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
      getEnvironmentSummary: () => gitHost.getEnvironmentSummary(),
      onEditorDirtyChange: (dirty) => {
        editorHasUnsavedChanges = dirty;
      },
      onAsyncError: reportAsyncError,
    },
  );
  const mainViewIpc = installDesktopMainViewIpc(window, {
    workspace: workspaceIpc,
    executeAgent: async (message) => {
      const execution = await getAgentExecution();
      void execution.handleExecute(message).catch(reportAsyncError);
    },
    fileSelection,
    prompt: promptController,
    settings: settingsIpc,
    progress: progressIpc,
    onboarding: onboardingIpc,
    logs: {
      readLog: () =>
        readDesktopLogSnapshot({ workspacePath: options.workspacePath }),
      copyLog: async (text) => {
        clipboard.writeText(text);
      },
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
    modelListRefresh,
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
    const workspaceRelaunch = pendingWorkspaceRelaunch;
    pendingWorkspaceRelaunch = undefined;
    const continueQuit = continueQuitAfterWindowClose;
    continueQuitAfterWindowClose = undefined;
    windowClosed = true;
    disposeWindowTitle();
    presentationAbort.abort();
    executionsWatcher?.close();
    if (mainWindow === window) {
      mainWindow = null;
      if (process.platform === 'darwin') {
        Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }]));
      }
    }
    if (agentExecution) {
      agentExecution.dispose();
    } else {
      void agentExecutionLoad
        ?.then((execution) => execution.dispose())
        .catch((error: unknown) => {
          if (!(error instanceof Error && error.name === 'AbortError')) {
            reportAsyncError(error);
          }
        });
    }
    desktopAuth.dispose();
    setupSignInRegistration.dispose();
    // Shells keep running and web contents keep loading unless explicitly torn
    // down — neither is reachable once the window is gone.
    ptyHost.disposeAll();
    browserViews.disposeAll();
    if (workspaceRelaunch) {
      void (async () => {
        try {
          await platform().globalState.update(
            DESKTOP_WORKSPACE_PATH_STATE_KEY,
            workspaceRelaunch.selectedPath,
          );
        } catch (error) {
          reportAsyncError(error);
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
    void options.initializeCrashReporting();
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
      const transcripts = await StreamLogStore.open();
      const processSession = new SessionHandle({
        transcripts,
        restartRepair: 'deferred',
      });
      const detachTerminalResultToast = attachTerminalResultToast(
        processSession,
        processSession.interactions,
        { replayWhenAttached: true },
      );
      let disposeProcessStores = (): void => undefined;
      let disposeAgentResumeHandler = (): void => undefined;
      let sessionStores!: SessionStores;
      lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () => {
        disposeAgentResumeHandler();
      });
      registerAgentShutdownHandlers(lifecycle);
      // Agent shutdown runs first so its final events enter the process-owned
      // stores. Flush in BEFORE so persistence cannot be delayed by a later
      // ON-phase language-service disposal.
      lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
        processSession.flushArtifacts(),
      );
      lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () => {
        disposeAgentResumeHandler();
        detachTerminalResultToast();
        disposeProcessStores();
        processSession.dispose();
      });

      // Until the initial window is fully wired, any startup failure must run
      // the same process-session shutdown used by an ordinary application
      // exit. Once this block completes, the lifecycle owns that cleanup.
      try {
        const processStores = await initializeDesktopProcessStores({
          session: processSession,
          legacyStreamFilePath: protocolLifecycle.ownsSingleInstanceLock
            ? join(app.getPath('userData'), 'streams.json')
            : undefined,
        });
        disposeProcessStores = () => processStores.dispose();
        await processSession.waitUntilReady();
        sessionStores = processStores.stores;
        disposeAgentResumeHandler = processResumeOwner.attach({
          session: processSession,
        });
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

        let crashReportingInitialized = false;
        let crashReportingInitialization: Promise<void> | undefined;
        const initializeCrashReporting = async (): Promise<void> => {
          if (crashReportingInitialized) return;
          crashReportingInitialization ??= (async () => {
            try {
              crashReportingInitialized = await initializeDesktopCrashReporting(
                {
                  globalState: platform().globalState,
                  secrets: platform().secrets,
                  sensitivePaths: [
                    platformInit.workspacePath,
                    app.getPath('userData'),
                    platformInit.dataRoot,
                  ],
                  log: console,
                },
              );
            } finally {
              if (!crashReportingInitialized) {
                crashReportingInitialization = undefined;
              }
            }
          })();
          await crashReportingInitialization;
        };
        const authCoordinator = createDesktopAuthCoordinator({
          secrets: platform().secrets,
          log: console,
        });
        const authCallbackState = createDesktopAuthCallbackState(
          platform().globalState,
        );
        installContentSecurityPolicy();
        reopenMainWindow = () =>
          createWindow({
            workspacePath: platformInit.workspacePath,
            authCoordinator,
            authCallbackState,
            initializeCrashReporting,
            processSession,
            sessionStores,
            hasPriorInstall: platformInit.hasPriorInstall,
            resourcesPath: platformInit.resourcesPath,
          });
        reopenMainWindow();

        app.on('activate', () => {
          if (BrowserWindow.getAllWindows().length === 0) {
            reopenMainWindow?.();
          }
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
  if (workspaceRelaunchInProgress) return;
  if (process.platform !== 'darwin') app.quit();
});
