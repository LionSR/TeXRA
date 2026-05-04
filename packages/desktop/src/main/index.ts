import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, session, shell } from 'electron';

import { getAgentDirectories } from '@agent/index/agentDirectoriesRegistry';
import { createDesktopAgentExecution } from './desktopAgentExecution.js';
import { installDesktopMainViewIpc } from './mainViewIpc.js';
import { initializeElectronPlatform } from './platform/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const PRODUCTION_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self';";
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

function createWindow(): void {
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
    },
  });
  const ipcRef: {
    current?: ReturnType<typeof installDesktopMainViewIpc>;
  } = {};
  const openPath = async (filePath: string) => {
    const errorMessage = await shell.openPath(filePath);
    if (errorMessage) throw new Error(errorMessage);
  };
  const agentExecution = createDesktopAgentExecution({
    postToRenderer: (message) => ipcRef.current?.postToRenderer(message),
    openPath,
    showErrorMessage: async (message) => {
      await dialog.showMessageBox(window, { message, type: 'error' });
    },
  });
  const mainViewIpc = installDesktopMainViewIpc(window, {
    getCustomAgentDirectory: () => getAgentDirectories().custom(),
    openPath,
    executeAgent: (message) => agentExecution.handleExecute(message),
  });
  ipcRef.current = mainViewIpc;
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
    await initializeElectronPlatform(__dirname);
    installContentSecurityPolicy();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
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
