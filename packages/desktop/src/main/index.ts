import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, session, shell } from 'electron';

import { platform } from '@platform/platform';
import { getAgentDirectories } from '@agent/index/agentDirectoriesRegistry';
import { createDesktopAgentExecution } from './desktopAgentExecution.js';
import { createDesktopFileSelection } from './desktopFileSelection.js';
import {
  attachRendererConsoleLog,
  getDesktopLogDirectory,
} from './desktopAppLog.js';
import { installDesktopMenu } from './desktopMenu.js';
import { createDesktopProgressIpc } from './desktopProgressIpc.js';
import { createDesktopSettingsIpc } from './desktopSettingsIpc.js';
import { createDesktopShellActions } from './desktopShellIpc.js';
import { installDesktopMainViewIpc } from './mainViewIpc.js';
import { initializeElectronPlatform } from './platform/index.js';
import {
  DESKTOP_WORKSPACE_PATH_STATE_KEY,
  serializeWorkspacePresenceArg,
  withWorkspacePathArg,
} from '../workspacePath.js';

const moduleDirname = fileURLToPath(new URL('.', import.meta.url));
const __dirname = findDesktopMainDir(moduleDirname);

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
].join('; ');
const DEVELOPMENT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*",
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

function createWindow(options: { workspacePath: string | undefined }): void {
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
      additionalArguments: [
        serializeWorkspacePresenceArg(options.workspacePath != null),
      ],
    },
  });
  const reportAsyncError = (error: unknown) => console.error(error);
  const ipcRef: {
    current?: ReturnType<typeof installDesktopMainViewIpc>;
  } = {};
  const openPath = async (filePath: string) => {
    const errorMessage = await shell.openPath(filePath);
    if (errorMessage) throw new Error(errorMessage);
  };
  const openLogsFolder = async () => openPath(getDesktopLogDirectory());
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
    openPath,
    showErrorMessage: async (message) => {
      await dialog.showMessageBox(window, { message, type: 'error' });
    },
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
  const settingsIpc = createDesktopSettingsIpc({
    postToRenderer: (message) => ipcRef.current?.postToRenderer(message),
    sendStartupCatalogData: true,
    selectCustomAgentDirectory: async () => {
      const result = await dialog.showOpenDialog(window, {
        title: 'Select Custom Agents Folder',
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
    openExternalUrl: async (url) => {
      await shell.openExternal(url);
    },
    installToolExtension: async (extensionId) => {
      await shell.openExternal(
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
    onError: reportAsyncError,
  });
  const progressIpc = createDesktopProgressIpc({
    progress: agentExecution.progress,
    onAsyncError: reportAsyncError,
  });
  const shellActions = createDesktopShellActions(
    { postToRenderer: (message) => ipcRef.current?.postToRenderer(message) },
    {
      getCustomAgentDirectory: () => getAgentDirectories().custom(),
      openLogFolder: openLogsFolder,
      openPath,
      openWorkspaceFolder,
      onAsyncError: reportAsyncError,
    },
  );
  const mainViewIpc = installDesktopMainViewIpc(window, {
    executeAgent: (message) => agentExecution.handleExecute(message),
    fileSelection,
    settings: settingsIpc,
    progress: progressIpc,
    shellActions,
    onAsyncError: reportAsyncError,
  });
  ipcRef.current = mainViewIpc;
  installDesktopMenu(shellActions);
  window.once('closed', () => agentExecution.dispose());

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
    return;
  }

  void window.loadFile(join(__dirname, '../renderer/index.html'));
}

app
  .whenReady()
  .then(async () => {
    const platformInit = await initializeElectronPlatform(__dirname);
    installContentSecurityPolicy();
    createWindow({ workspacePath: platformInit.workspacePath });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow({ workspacePath: platformInit.workspacePath });
      }
    });
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to start TeXRA desktop: ${message}`);
    app.quit();
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
