import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  session,
  shell,
} from 'electron';

import { platform } from '@platform/platform';
import { getAgentDirectories } from '@agent/index/agentDirectoriesRegistry';
import { killBackgroundProcesses } from '@agent/runtime/executionRegistry';
import { getServerSideKeyService } from '@auth/serverKeys';
import { SHUTDOWN_PHASE } from '@platform/interfaces/lifecycle';
import { interruptAllCodexSessions } from '@tools/codex';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import { setOpenBuildDisplay } from '@tools/approval/latexPreview';
import { createDesktopAgentExecution } from './desktopAgentExecution.js';
import { createDesktopDiffHost } from './desktopDiffHost.js';
import { createDesktopFileSelection } from './desktopFileSelection.js';
import { createDesktopPreviewHost } from './desktopPreviewHost.js';
import { installDesktopProtocolCallbackLifecycle } from './desktopProtocolCallbacks.js';
import { createDesktopWorkspaceExplorer } from './desktopWorkspaceExplorer.js';
import {
  attachRendererConsoleLog,
  getDesktopLogDirectory,
  readDesktopLogSnapshot,
} from './desktopAppLog.js';
import { installDesktopMenu } from './desktopMenu.js';
import { installDesktopNavigationPolicy } from './desktopNavigationPolicy.js';
import { createDesktopOnboardingIpc } from './desktopOnboardingIpc.js';
import { refreshDesktopModelListStateIfNeeded } from './desktopModelListRefresh.js';
import { promptInRenderer } from './desktopPrompt.js';
import { createDesktopProgressIpc } from './desktopProgressIpc.js';
import { createDesktopSettingsIpc } from './desktopSettingsIpc.js';
import { createDesktopShellActions } from './desktopShellIpc.js';
import {
  createDesktopAuthCallbackState,
  createDesktopAuthCoordinator,
  createDesktopSupabaseAuth,
  initializeDesktopServerSideKeyAccess,
  type DesktopAuthCallbackState,
  type DesktopAuthCoordinator,
} from './desktopSupabaseAuth.js';
import { reportFatalStartupError } from './fatalStartupError.js';
import { installDesktopMainViewIpc } from './mainViewIpc.js';
import { initializeDesktopCrashReporting } from './desktopCrashReporting.js';
import { initializeElectronPlatform } from './platform/index.js';
import {
  DESKTOP_WORKSPACE_PATH_STATE_KEY,
  serializeWorkspacePresenceArg,
  withWorkspacePathArg,
} from '../workspacePath.js';

const moduleDirname = fileURLToPath(new URL('.', import.meta.url));
const __dirname = findDesktopMainDir(moduleDirname);
let mainWindow: BrowserWindow | null = null;
let reopenMainWindow: (() => void) | undefined;

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
  "connect-src 'self' data:",
].join('; ');
const DEVELOPMENT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
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
}): void {
  const window = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    title: 'TeXRA',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      additionalArguments: [
        serializeWorkspacePresenceArg(options.workspacePath != null),
      ],
    },
  });
  mainWindow = window;
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
  const settingsIpcRef: {
    current?: ReturnType<typeof createDesktopSettingsIpc>;
  } = {};
  const showErrorMessage = async (message: string) => {
    await dialog.showMessageBox(window, { message, type: 'error' });
  };
  const previewHost = createDesktopPreviewHost({
    shell,
    showErrorMessage,
  });
  const refreshDesktopAuthSurfaces = async () => {
    const profile = await desktopAuth.getProfileData();
    ipcRef.current?.postToRenderer({
      command: profile.authenticated
        ? MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER
        : MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER,
    });
    await settingsIpcRef.current?.refreshAuthDependentData();
  };
  const desktopAuth = createDesktopSupabaseAuth({
    router: protocolLifecycle.router,
    coordinator: options.authCoordinator,
    secrets: platform().secrets,
    openExternalUrl: (url) => previewHost.openExternal(url),
    showInfoMessage: async (message) => {
      await dialog.showMessageBox(window, { type: 'info', message });
    },
    showErrorMessage,
    onSessionChanged: refreshDesktopAuthSurfaces,
    log: console,
    callbackState: options.authCallbackState,
  });
  setOpenBuildDisplay(previewHost.openBuildDisplay);
  const openLogsFolder = async () =>
    previewHost.openPath(getDesktopLogDirectory());
  const openWorkspaceFolder = async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Open Workspace Folder',
      properties: ['openDirectory'],
    });
    const selectedPath = result.canceled ? undefined : result.filePaths[0];
    if (!selectedPath) return;

    await platform().globalState.update(
      DESKTOP_WORKSPACE_PATH_STATE_KEY,
      selectedPath,
    );
    app.relaunch({
      args: withWorkspacePathArg(process.argv.slice(1), selectedPath),
    });
    app.exit(0);
  };
  attachRendererConsoleLog(window.webContents);
  const agentExecution = createDesktopAgentExecution({
    postToRenderer: (message) => ipcRef.current?.postToRenderer(message),
    opener: previewHost,
    diff: createDesktopDiffHost({
      openPath: previewHost.openPath,
    }),
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
    showInfoMessage: async (message) => {
      await dialog.showMessageBox(window, { type: 'info', message });
    },
    showErrorMessage,
  });
  const fileSelection = createDesktopFileSelection({
    postToRenderer: (message) => ipcRef.current?.postToRenderer(message),
    showOpenFileDialog: async (options) => {
      const result = await dialog.showOpenDialog(window, {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
        properties: ['openFile'],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
    onError: reportAsyncError,
  });
  const workspaceExplorer = createDesktopWorkspaceExplorer({
    postToRenderer: (message) => ipcRef.current?.postToRenderer(message),
    openPath: previewHost.openPath,
    onError: reportAsyncError,
  });
  const settingsIpc = createDesktopSettingsIpc({
    postToRenderer: (message) => ipcRef.current?.postToRenderer(message),
    sendStartupCatalogData: true,
    modelListRefresh,
    promptSecret: (input) =>
      promptInRenderer(window, { ...input, password: true }),
    promptText: (input) => promptInRenderer(window, input),
    showInfoMessage: async (message) => {
      await dialog.showMessageBox(window, { type: 'info', message });
    },
    showErrorMessage: async (message) => {
      await dialog.showMessageBox(window, { type: 'error', message });
    },
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
    signIn: () => desktopAuth.signIn(),
    signOut: () => desktopAuth.signOut(),
    getAuthProfileData: () => desktopAuth.getProfileData(),
    setApiAccessMode: async (mode) => {
      await getServerSideKeyService().setUseIncludedModelAccess(
        mode === 'included',
      );
    },
    initializeCrashReporting: options.initializeCrashReporting,
    selectCustomAgentDirectory: async () => {
      const result = await dialog.showOpenDialog(window, {
        title: 'Select Custom Agents Folder',
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
    openPath: previewHost.openPath,
    revealPath: async (filePath) => {
      shell.showItemInFolder(filePath);
    },
    openExternalUrl: (url) => previewHost.openExternal(url),
    installToolExtension: async (extensionId) => {
      await previewHost.openExternal(
        `https://marketplace.visualstudio.com/items?itemName=${encodeURIComponent(extensionId)}`,
      );
    },
    runToolCommand: async ({ command }) => {
      await dialog.showMessageBox(window, {
        type: 'info',
        message: 'Run this setup command in a terminal',
        detail: command,
      });
    },
    runInstallCommand: async (command) => {
      await dialog.showMessageBox(window, {
        type: 'info',
        message: 'Run this setup command in a terminal',
        detail: command,
      });
    },
    onError: reportAsyncError,
  });
  settingsIpcRef.current = settingsIpc;
  const progressIpc = createDesktopProgressIpc({
    progress: agentExecution.progress,
    onAsyncError: reportAsyncError,
  });
  const onboardingIpc = createDesktopOnboardingIpc(
    { postToRenderer: (message) => ipcRef.current?.postToRenderer(message) },
    { onAsyncError: reportAsyncError },
  );
  const shellActions = createDesktopShellActions(
    { postToRenderer: (message) => ipcRef.current?.postToRenderer(message) },
    {
      getCustomAgentDirectory: () => getAgentDirectories().custom(),
      openExternalUrl: previewHost.openExternal,
      openLogFolder: openLogsFolder,
      openPath: previewHost.openPath,
      openWorkspaceFolder,
      signIn: () => desktopAuth.signIn(),
      onAsyncError: reportAsyncError,
    },
  );
  const mainViewIpc = installDesktopMainViewIpc(window, {
    executeAgent: (message) => agentExecution.handleExecute(message),
    fileSelection,
    workspaceExplorer,
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
      authenticated: (await desktopAuth.getProfileData()).authenticated,
    }),
    onAsyncError: reportAsyncError,
  });
  ipcRef.current = mainViewIpc;
  installDesktopMenu(shellActions);
  window.once('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
    agentExecution.dispose();
    desktopAuth.dispose();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
    return;
  }

  void window.loadFile(join(__dirname, '../renderer/index.html'));
}

if (protocolLifecycle.shouldContinue) {
  app
    .whenReady()
    .then(async () => {
      const platformInit = await initializeElectronPlatform(__dirname);
      const { lifecycle } = platformInit;
      lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
        killBackgroundProcesses(),
      );
      lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
        interruptAllCodexSessions(),
      );

      let isShuttingDown = false;
      app.on('before-quit', (event) => {
        if (isShuttingDown) return;
        event.preventDefault();
        isShuttingDown = true;
        void lifecycle.runShutdown().finally(() => app.quit());
      });

      let crashReportingInitialized = false;
      let crashReportingInitialization: Promise<void> | undefined;
      const initializeCrashReporting = async (): Promise<void> => {
        if (crashReportingInitialized) return;
        crashReportingInitialization ??= (async () => {
          try {
            crashReportingInitialized = await initializeDesktopCrashReporting({
              globalState: platform().globalState,
              secrets: platform().secrets,
              sensitivePaths: [
                platformInit.workspacePath,
                app.getPath('userData'),
              ],
              log: console,
            });
          } finally {
            if (!crashReportingInitialized) {
              crashReportingInitialization = undefined;
            }
          }
        })();
        await crashReportingInitialization;
      };
      await initializeCrashReporting();
      const authCoordinator = createDesktopAuthCoordinator({
        secrets: platform().secrets,
        log: console,
      });
      const authCallbackState = createDesktopAuthCallbackState(
        platform().globalState,
      );
      initializeDesktopServerSideKeyAccess(console);
      installContentSecurityPolicy();
      reopenMainWindow = () =>
        createWindow({
          workspacePath: platformInit.workspacePath,
          authCoordinator,
          authCallbackState,
          initializeCrashReporting,
        });
      reopenMainWindow();

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          reopenMainWindow?.();
        }
      });
    })
    .catch((error: unknown) => {
      reportFatalStartupError(error);
    });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
