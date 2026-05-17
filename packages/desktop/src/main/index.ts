import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
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
import { SHUTDOWN_PHASE } from '@platform/interfaces/lifecycle';
import { getAgentDirectories } from '@agent/index/agentDirectoriesRegistry';
import { killBackgroundProcesses } from '@agent/runtime/executionRegistry';
import { getServerSideKeyService } from '@auth/serverKeys';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import type { TerminalRunResult } from '@hosts/terminalHost';
import { interruptAllCodexSessions } from '@tools/codex';
import { interruptAllClaudeAgentSessions } from '@tools/claudeAgent';
import { refreshToolAvailability } from '@tools/toolAvailability';
import { setOpenBuildDisplay } from '@tools/approval/latexPreview';
import { createDesktopAgentExecution } from './desktopAgentExecution.js';
import {
  openDesktopStreamSnapshotStore,
  type DesktopStreamSnapshotStore,
} from './desktopStreamSnapshot.js';
import { createDesktopDiffHost } from './desktopDiffHost.js';
import { createDesktopFileSelection } from './desktopFileSelection.js';
import { createDesktopPreviewHost } from './desktopPreviewHost.js';
import { installDesktopProtocolCallbackLifecycle } from './desktopProtocolCallbacks.js';
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
import { createDesktopGitHost } from './desktopGitHost.js';
import { createDesktopShellActions } from './desktopShellIpc.js';
import {
  openMacTerminalCommand,
  setupCommandNeedsInteractiveTerminal,
} from './desktopSetupTerminal.js';
import { createDesktopTerminalRunner } from './desktopTerminalRunner.js';
import {
  DesktopSetupTerminalCancelMessageSchema,
  buildDesktopSetupTerminalAppendMessage,
  buildDesktopSetupTerminalCompleteMessage,
  buildDesktopSetupTerminalShowMessage,
} from '../desktopSetupTerminalMessages.js';
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
  withNewWindowWorkspaceArgs,
  withWorkspacePathArg,
} from '../workspacePath.js';

const moduleDirname = fileURLToPath(new URL('.', import.meta.url));
const __dirname = findDesktopMainDir(moduleDirname);
let mainWindow: BrowserWindow | null = null;
let reopenMainWindow: (() => void) | undefined;

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
  "connect-src 'self' data:",
].join('; ');
const SETUP_COMMAND_TIMEOUT_MS = 10 * 60_000;
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

async function showSetupCommandResult(
  window: BrowserWindow,
  command: string,
  result: TerminalRunResult,
): Promise<void> {
  const output = result.output.trim();
  const hasOutput = output.length > 0;
  const timedOut = result.timedOut;
  const failed =
    !timedOut && result.exitCode !== undefined && result.exitCode !== 0;
  const unknownExit = !timedOut && result.exitCode === undefined;
  const buttons = hasOutput
    ? ['Copy Output', 'Copy Command', 'Close']
    : ['Copy Command', 'Close'];
  const response = await dialog.showMessageBox(window, {
    type: timedOut || unknownExit ? 'warning' : failed ? 'error' : 'info',
    message: timedOut
      ? 'Setup command timed out'
      : failed
        ? `Setup command failed with exit code ${result.exitCode}`
        : unknownExit
          ? 'Setup command finished without an observable exit code'
          : 'Setup command finished',
    detail: [`Command:\n${command}`, output ? `Output:\n${output}` : '']
      .filter(Boolean)
      .join('\n\n'),
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  });

  if (hasOutput && response.response === 0) {
    clipboard.writeText(output);
  } else if (
    (hasOutput && response.response === 1) ||
    (!hasOutput && response.response === 0)
  ) {
    clipboard.writeText(command);
  }
}

function setupCommandExceptionResult(error: unknown): TerminalRunResult {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : 'Error';
  return {
    exitCode: undefined,
    output: `${name}: ${message}`,
    timedOut: false,
  };
}

async function showSetupCommandOpenedInTerminal(
  window: BrowserWindow,
  command: string,
): Promise<void> {
  const response = await dialog.showMessageBox(window, {
    type: 'info',
    message: 'Setup command opened in Terminal',
    detail:
      `Command:\n${command}\n\n` +
      'Complete any prompts in the Terminal window, then return to TeXRA and recheck the dependency status.',
    buttons: ['Copy Command', 'Close'],
    defaultId: 1,
    cancelId: 1,
  });

  if (response.response === 0) {
    clipboard.writeText(command);
  }
}

async function showManualSetupCommand(
  window: BrowserWindow,
  command: string,
): Promise<void> {
  const response = await dialog.showMessageBox(window, {
    type: 'warning',
    message: 'Setup command needs an interactive terminal',
    detail:
      `Command:\n${command}\n\n` +
      'This command may ask for a password or confirmation. TeXRA will not run it in a hidden process. Copy it into a terminal, then return to TeXRA and recheck the dependency status.',
    buttons: ['Copy Command', 'Close'],
    defaultId: 0,
    cancelId: 1,
  });

  if (response.response === 0) {
    clipboard.writeText(command);
  }
}

function createWindow(options: {
  workspacePath: string | undefined;
  authCoordinator: DesktopAuthCoordinator;
  authCallbackState: DesktopAuthCallbackState;
  initializeCrashReporting: () => Promise<void>;
  streamSnapshotStore?: DesktopStreamSnapshotStore;
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
        ...(options.workspacePath
          ? [`--texra-workspace-path=${options.workspacePath}`]
          : []),
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
  const setupCommandCwd = options.workspacePath ?? app.getPath('home');
  const setupTerminalRunner = createDesktopTerminalRunner({
    cwd: setupCommandCwd,
  });
  let setupCommandCounter = 0;
  const activeSetupCommands = new Map<string, AbortController>();
  const postSetupTerminalMessage = (message: unknown): boolean => {
    const ipc = ipcRef.current;
    if (!ipc) return false;
    if (window.isDestroyed() || window.webContents.isDestroyed()) return false;
    ipc.postToRenderer(message);
    return true;
  };
  const runSetupCommandInOverlay = async (command: string) => {
    const runId = `setup-${Date.now()}-${++setupCommandCounter}`;
    const abortController = new AbortController();
    activeSetupCommands.set(runId, abortController);
    const rendererReady = postSetupTerminalMessage(
      buildDesktopSetupTerminalShowMessage({
        runId,
        title: 'TeXRA Setup',
        shellCommand: command,
        cwd: setupCommandCwd,
      }),
    );

    let result: TerminalRunResult;
    try {
      result = await setupTerminalRunner.runCommand({
        name: 'TeXRA Setup',
        command,
        cwd: setupCommandCwd,
        timeoutMs: SETUP_COMMAND_TIMEOUT_MS,
        signal: abortController.signal,
        onOutput: ({ stream, chunk }) => {
          postSetupTerminalMessage(
            buildDesktopSetupTerminalAppendMessage({ runId, stream, chunk }),
          );
        },
      });
    } catch (error: unknown) {
      result = setupCommandExceptionResult(error);
    } finally {
      activeSetupCommands.delete(runId);
    }

    const status = result.cancelled
      ? 'cancelled'
      : result.timedOut
        ? 'timed-out'
        : result.exitCode === 0
          ? 'succeeded'
          : 'failed';
    postSetupTerminalMessage(
      buildDesktopSetupTerminalCompleteMessage({
        runId,
        status,
        exitCode: result.exitCode ?? null,
        output: result.output,
      }),
    );
    if (!rendererReady) {
      await showSetupCommandResult(window, command, result);
    }
  };
  const setupTerminalIpc = {
    handleMessage(message: { command: string } & Record<string, unknown>) {
      const parsed = DesktopSetupTerminalCancelMessageSchema.safeParse(message);
      if (!parsed.success) return false;
      activeSetupCommands.get(parsed.data.runId)?.abort();
      return true;
    },
  };
  const runSetupCommand = async (command: string) => {
    if (
      process.platform === 'darwin' &&
      setupCommandNeedsInteractiveTerminal(command)
    ) {
      try {
        await openMacTerminalCommand(command, setupCommandCwd);
        await showSetupCommandOpenedInTerminal(window, command);
      } catch {
        await showManualSetupCommand(window, command);
      }
      return;
    }

    if (setupCommandNeedsInteractiveTerminal(command)) {
      await showManualSetupCommand(window, command);
      return;
    }

    await runSetupCommandInOverlay(command);
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
    postToRenderer: (message) => {
      const ipc = ipcRef.current;
      if (!ipc) return false;
      // `installDesktopHostBridge.postToRenderer` is itself a no-op when
      // `webContents.isDestroyed()`. Without checking that here too, this
      // wrapper would falsely report success and the preview host would
      // skip the external-viewer fallback. Bot review (#3816) caught it.
      if (window.isDestroyed() || window.webContents.isDestroyed()) {
        return false;
      }
      ipc.postToRenderer(message);
      return true;
    },
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
  const openWorkspaceInNewWindow = async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Open Folder in New Window',
      properties: ['openDirectory'],
    });
    const selectedPath = result.canceled ? undefined : result.filePaths[0];
    if (!selectedPath) return;

    spawn(
      process.execPath,
      withNewWindowWorkspaceArgs(process.argv.slice(1), selectedPath),
      {
        detached: true,
        stdio: 'ignore',
      },
    ).unref();
  };
  attachRendererConsoleLog(window.webContents);
  const agentExecution = createDesktopAgentExecution({
    postToRenderer: (message) => ipcRef.current?.postToRenderer(message),
    opener: previewHost,
    diff: createDesktopDiffHost({
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
    streamSnapshotStore: options.streamSnapshotStore,
  });
  const fileSelection = createDesktopFileSelection({
    postToRenderer: (message) => ipcRef.current?.postToRenderer(message),
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
      // The desktop shell can't host VS Code extensions, so opening the
      // marketplace URL was misleading. Surface an info dialog that names
      // the extension and lets the user open the marketplace listing only
      // if they explicitly want to install it inside VS Code. The 'Copy ID'
      // button gives them the bare extension id for `code --install-extension`.
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
    },
    runToolCommand: async ({ command }) => {
      await runSetupCommand(command);
    },
    refreshToolAvailability: () =>
      refreshToolAvailability(agentExecution.progress.runtimeHost),
    runInstallCommand: async (command) => {
      await runSetupCommand(command);
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
  // Real desktop git host — closes audit item A from
  // `docs/dev/standalone-trajectory-audit.md` (trajectory #16). Spawns
  // `git log` under the active workspace to populate the launcher banner's
  // recent-commits picker. The host is stateless and re-probes per request,
  // so workspace switches don't need cache invalidation.
  const gitHost = createDesktopGitHost({
    getWorkspacePath: () => options.workspacePath,
    onError: reportAsyncError,
  });
  const shellActions = createDesktopShellActions(
    { postToRenderer: (message) => ipcRef.current?.postToRenderer(message) },
    {
      getCustomAgentDirectory: () => getAgentDirectories().custom(),
      openExternalUrl: previewHost.openExternal,
      openLogFolder: openLogsFolder,
      openPath: previewHost.openPath,
      openWorkspaceInNewWindow,
      openWorkspaceFolder,
      signIn: () => desktopAuth.signIn(),
      getRecentCommits: () => gitHost.getRecentCommits(),
      onAsyncError: reportAsyncError,
    },
  );
  const mainViewIpc = installDesktopMainViewIpc(window, {
    executeAgent: (message) => agentExecution.handleExecute(message),
    fileSelection,
    settings: settingsIpc,
    progress: progressIpc,
    onboarding: onboardingIpc,
    setupTerminal: setupTerminalIpc,
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
  window.webContents.once('did-finish-load', () => {
    void options.initializeCrashReporting();
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
      lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
        interruptAllClaudeAgentSessions(),
      );

      // before-quit semantics: hold every quit event until shutdown handlers
      // have finished draining (a second Cmd+Q while we're mid-drain must NOT
      // be allowed to terminate the process). Only after runShutdown resolves
      // do we let Electron's own quit sequence proceed — and we mark
      // shutdownStarted to avoid re-entering the runShutdown chain.
      let shutdownStarted = false;
      let quitting = false;
      app.on('before-quit', (event) => {
        if (quitting) return;
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
      const authCoordinator = createDesktopAuthCoordinator({
        secrets: platform().secrets,
        log: console,
      });
      const authCallbackState = createDesktopAuthCallbackState(
        platform().globalState,
      );
      initializeDesktopServerSideKeyAccess(console);
      installContentSecurityPolicy();
      // Cross-launch stream rail persistence — audit item D /
      // trajectory #19. A failed open shouldn't block app startup,
      // so we treat it as "no snapshot available" and continue.
      let streamSnapshotStore: DesktopStreamSnapshotStore | undefined;
      try {
        streamSnapshotStore = await openDesktopStreamSnapshotStore(
          join(app.getPath('userData'), 'streams.json'),
        );
      } catch (error) {
        console.warn('Failed to open desktop stream snapshot store', error);
      }
      reopenMainWindow = () =>
        createWindow({
          workspacePath: platformInit.workspacePath,
          authCoordinator,
          authCallbackState,
          initializeCrashReporting,
          streamSnapshotStore,
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
