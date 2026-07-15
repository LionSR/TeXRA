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
import { SHUTDOWN_PHASE, type LifecycleHost } from '@platform/interfaces';
import { LatexConfigPersistenceController } from '@controllers/settingsView/LatexConfigPersistenceController';
import { LatexToolingController } from '@controllers/settingsView/LatexToolingController';
import {
  computeAgentOptionsData,
  getAgent,
  getAgentsByCategory,
  getVisibleAgents,
  loadAgents,
  refresh,
} from '@agent/index/agentRegistry';
import { registerAgentShutdownHandlers } from '@agent/runtime/agentShutdown';
import { getAllActiveExecutionIds } from '@agent/runtime/SessionHandle';
import { getServerSideKeyService } from '@auth/serverKeys';
import { SupabaseClient } from '@auth/SupabaseClient';
import type { TerminalRunResult } from '@hosts/uiHosts';
import { hasUsableSetupCredential } from '@model/setupCredentialAccess';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { normalizePlatform } from '@shared/constants/latex';
import {
  AgentCategory,
  agentKeyOf,
  type AgentSource,
} from '@shared/schemas/agent';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { backfillFirstRunDone } from '@shared/state/onboardingState';
import { setOpenBuildDisplay } from '@tools/approval/latexPreview';
import { BinaryResolver } from '@utils/system/binaryResolver';
import {
  checkToolInstalled,
  detectPackageManager,
} from '@utils/system/toolUtils';
import { setDesktopAgentResumeHandler } from './desktopAgentResume.js';
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
import {
  createDesktopOnboardingIpc,
  type DesktopOnboardingIpc,
} from './desktopOnboardingIpc.js';
import { refreshDesktopModelListStateIfNeeded } from './desktopModelListRefresh.js';
import { promptInRenderer } from './desktopPrompt.js';
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
  openMacTerminalCommand,
  setupCommandNeedsInteractiveTerminal,
} from './desktopSetupTerminal.js';
import { createDesktopTerminalRunner } from './desktopTerminalRunner.js';
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
  initializeDesktopServerSideKeyAccess,
  type DesktopAuthCallbackState,
  type DesktopAuthCoordinator,
} from './desktopSupabaseAuth.js';
import { DESKTOP_DOCS_URL } from '../desktopCommandSurface.js';
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
import type {
  DesktopAgentExecution,
  DesktopAgentExecutionOptions,
} from './desktopAgentExecution.js';
import type { StreamSnapshotStore } from '@transcript';

const moduleDirname = fileURLToPath(new URL('.', import.meta.url));
const desktopMainDir = findDesktopMainDir(moduleDirname);
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

function describeSetupCommandOutcome(result: TerminalRunResult): {
  type: 'warning' | 'error' | 'info';
  message: string;
} {
  if (result.timedOut) {
    return { type: 'warning', message: 'Setup command timed out' };
  }
  if (result.exitCode === undefined) {
    return {
      type: 'warning',
      message: 'Setup command finished without an observable exit code',
    };
  }
  if (result.exitCode !== 0) {
    return {
      type: 'error',
      message: `Setup command failed with exit code ${result.exitCode}`,
    };
  }
  return { type: 'info', message: 'Setup command finished' };
}

async function showSetupCommandResult(
  window: BrowserWindow,
  command: string,
  result: TerminalRunResult,
): Promise<void> {
  const output = result.output.trim();
  const hasOutput = output.length > 0;
  const buttons = hasOutput
    ? ['Copy Output', 'Copy Command', 'Close']
    : ['Copy Command', 'Close'];
  const { type, message } = describeSetupCommandOutcome(result);
  const response = await dialog.showMessageBox(window, {
    type,
    message,
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

async function showCopyCommandDialog(
  window: BrowserWindow,
  command: string,
  options: {
    type: 'info' | 'warning';
    message: string;
    detail: string;
    defaultId: 0 | 1;
  },
): Promise<void> {
  const response = await dialog.showMessageBox(window, {
    type: options.type,
    message: options.message,
    detail: options.detail,
    buttons: ['Copy Command', 'Close'],
    defaultId: options.defaultId,
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
  await showCopyCommandDialog(window, command, {
    type: 'warning',
    message: 'Setup command needs an interactive terminal',
    detail:
      `Command:\n${command}\n\n` +
      'This command may ask for a password or confirmation. TeXRA will not run it in a hidden process. Copy it into a terminal, then return to TeXRA and recheck the dependency status.',
    defaultId: 0,
  });
}

function createWindow(options: {
  workspacePath: string | undefined;
  authCoordinator: DesktopAuthCoordinator;
  authCallbackState: DesktopAuthCallbackState;
  initializeCrashReporting: () => Promise<void>;
  lifecycle: LifecycleHost;
  streamSnapshotStore?: DesktopStreamSnapshotStore;
  progressSnapshotStore: StreamSnapshotStore;
  /**
   * Captured in `initializeElectronPlatform` BEFORE the bundled-agent sync
   * writes LAST_KNOWN_VERSION, so the onboarding backfill can tell a returning
   * veteran from a fresh install. See ElectronPlatformInitResult.hasPriorInstall.
   */
  hasPriorInstall: boolean;
  /** See ElectronPlatformInitResult.resourcesPath. */
  resourcesPath: string;
}): void {
  const window = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    title: 'TeXRA',
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
  const setupCommandCwd = options.workspacePath ?? app.getPath('home');
  const setupTerminalRunner = createDesktopTerminalRunner({
    cwd: setupCommandCwd,
  });
  const runSetupCommand = async (command: string) => {
    if (process.platform === 'darwin') {
      try {
        await openMacTerminalCommand(command, setupCommandCwd);
        await showCopyCommandDialog(window, command, {
          type: 'info',
          message: 'Setup command opened in Terminal',
          detail:
            `Command:\n${command}\n\n` +
            'Complete any prompts in the Terminal window, then return to TeXRA and recheck the dependency status.',
          defaultId: 1,
        });
      } catch {
        await showManualSetupCommand(window, command);
      }
      return;
    }

    if (setupCommandNeedsInteractiveTerminal(command)) {
      await showManualSetupCommand(window, command);
      return;
    }

    const result = await setupTerminalRunner.runCommand({
      name: 'TeXRA Setup',
      command,
      cwd: setupCommandCwd,
      timeoutMs: SETUP_COMMAND_TIMEOUT_MS,
    });
    await showSetupCommandResult(window, command, result);
  };
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
  const desktopAuth = createDesktopSupabaseAuth({
    router: protocolLifecycle.router,
    coordinator: options.authCoordinator,
    secrets: platform().secrets,
    openExternalUrl: (url) => previewHost.openExternal(url),
    showInfoMessage,
    showErrorMessage,
    onSessionChanged: refreshDesktopAuthSurfaces,
    log: console,
    callbackState: options.authCallbackState,
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
  setOpenBuildDisplay(previewHost.openBuildDisplay);
  const folderPickerDefaultPath = options.workspacePath ?? app.getPath('home');
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
      defaultPath: folderPickerDefaultPath,
      properties: ['openDirectory'],
    });
    const selectedPath = result.canceled ? undefined : result.filePaths[0];
    if (!selectedPath) return;

    // Not routed through executeCommand: this launches a new, independent
    // Electron window process (detached + unref'd) that must outlive this
    // process and is never awaited — executeCommand always awaits subprocess
    // completion, which would hang here.
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
  const agentExecutionOptions: DesktopAgentExecutionOptions = {
    postToRenderer: postToRendererIfAlive,
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
    showInfoMessage,
    showErrorMessage,
    streamSnapshotStore: options.streamSnapshotStore,
    progressSnapshotStore: options.progressSnapshotStore,
    // Recompute the onboarding funnel after a run completes so a user's first
    // successful run leaves the setup card without waiting for a restart
    // (the run lifecycle has already persisted firstRunDone). Mirrors the
    // extension's post-run refresh hooks in MainViewMessageHandler.
    onRunCompleted: () => {
      void onboardingIpcRef.current?.refreshOnboardingFunnel();
    },
  };
  let agentExecution: DesktopAgentExecution | undefined;
  let agentExecutionLoad: Promise<DesktopAgentExecution> | undefined;
  let agentExecutionShutdownRegistration: { dispose(): void } | undefined;
  let windowClosed = false;
  const getAgentExecution = async (): Promise<DesktopAgentExecution> => {
    if (agentExecution) return agentExecution;
    if (windowClosed) {
      throw new Error(
        'Cannot load desktop agent execution after window close.',
      );
    }

    agentExecutionLoad ??= import('./desktopAgentExecution.js')
      .then(async ({ createDesktopAgentExecution }) => {
        const created = await createDesktopAgentExecution(
          agentExecutionOptions,
        );
        if (windowClosed) {
          created.dispose();
          throw new Error(
            'Desktop window closed before agent execution finished loading.',
          );
        }
        agentExecutionShutdownRegistration = options.lifecycle.onShutdown(
          SHUTDOWN_PHASE.BEFORE,
          () => created.flush(),
        );
        agentExecution = created;
        return created;
      })
      .catch((error: unknown) => {
        agentExecutionLoad = undefined;
        throw error;
      });
    return agentExecutionLoad;
  };
  const disposeAgentResumeHandler = setDesktopAgentResumeHandler({
    async tryResumeStream(streamId) {
      try {
        return await (
          await getAgentExecution()
        ).progress.tryResumeStream(streamId);
      } catch (error) {
        if (!windowClosed) reportAsyncError(error);
        return false;
      }
    },
    isResumeInFlight(streamId) {
      return agentExecution?.progress.isResumeInFlight(streamId) ?? false;
    },
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
      postToRenderer: (message) => ipcRef.current?.postToRenderer(message),
    },
    prompts: {
      promptText: (input) => promptInRenderer(window, input),
      chooseTeamAvailability: async ({ presetName, unavailableNames }) => {
        const result = await dialog.showMessageBox(window, {
          type: 'warning',
          message: `Team "${presetName}" has unavailable TeXRA-hosted members: ${unavailableNames.join(', ')}.`,
          buttons: [
            'Sign in to TeXRA',
            'Continue with available members',
            'Cancel',
          ],
          defaultId: 0,
          cancelId: 2,
        });
        if (result.response === 0) return 'sign-in';
        if (result.response === 1) return 'continue';
        return 'cancel';
      },
    },
    remoteCatalog: {
      canAccess: () => SupabaseClient.canAccessRemoteAgentCatalog(),
      signIn: signInForRemoteAgentCatalog,
    },
    notifications: { showInfoMessage, showErrorMessage },
  });
  const credentialSettingsController =
    new DefaultDesktopCredentialSettingsController({
      workspaceState: platform().workspaceState,
      globalState: platform().globalState,
      config: platform().config,
      secrets: platform().secrets,
      renderer: {
        postToRenderer: (message) => ipcRef.current?.postToRenderer(message),
      },
      prompt: {
        input: (input) =>
          promptInRenderer(window, {
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
      workspaceState: platform().workspaceState,
      globalState: platform().globalState,
      renderer: {
        postToRenderer: (message) => ipcRef.current?.postToRenderer(message),
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
        postToRenderer: (message) => ipcRef.current?.postToRenderer(message),
      },
      prompt: {
        input: (input) =>
          promptInRenderer(window, { ...input, password: true }),
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
        await execution.progress.revealStream(streamId);
      } catch (error) {
        if (!windowClosed) reportAsyncError(error);
      }
    },
    onError: reportAsyncError,
  };
  const historySettingsController = new DesktopHistoryHandlers({
    resourcesPath: options.resourcesPath,
    postToRenderer: (message) => ipcRef.current?.postToRenderer(message),
    // Rerun and restore use the same host-neutral owners as the extension,
    // reached through the desktop execution bridge instead of VS Code commands.
    runExecution: async (request) => {
      await (await getAgentExecution()).progress.runExecution(request);
    },
    restoreTaskState: async (taskState) =>
      (await getAgentExecution()).progress.restoreTaskState(taskState),
    getActiveExecutionIds: getAllActiveExecutionIds,
    openPath: settingsUi.openPath,
    showInfoMessage: settingsUi.showInfoMessage,
    showErrorMessage: settingsUi.showErrorMessage,
    onError: settingsUi.onError,
  });
  const settingsIpc = createDesktopSettingsIpc({
    postToRenderer: (message) => ipcRef.current?.postToRenderer(message),
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
    getProgress: () => agentExecution?.progress,
    ensureProgress: async () => (await getAgentExecution()).progress,
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
    { postToRenderer: (message) => ipcRef.current?.postToRenderer(message) },
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
        await (await getAgentExecution()).handleExecute(message);
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
      getCustomAgentDirectory: () => platform().agentDirectories.custom(),
      openExternalUrl: previewHost.openExternal,
      openLogFolder: openLogsFolder,
      openPath: previewHost.openPath,
      openWorkspaceInNewWindow,
      openWorkspaceFolder,
      signIn: () => desktopAuth.signIn(),
      getRecentCommits: () => gitHost.getRecentCommits(),
      showInfoMessage,
      onAsyncError: reportAsyncError,
    },
  );
  const mainViewIpc = installDesktopMainViewIpc(window, {
    executeAgent: async (message) =>
      (await getAgentExecution()).handleExecute(message),
    fileSelection,
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
  installDesktopMenu(shellActions);
  window.once('closed', () => {
    windowClosed = true;
    if (mainWindow === window) {
      mainWindow = null;
    }
    disposeAgentResumeHandler();
    agentExecutionShutdownRegistration?.dispose();
    agentExecutionShutdownRegistration = undefined;
    if (agentExecution) {
      agentExecution.dispose();
    } else {
      void agentExecutionLoad
        ?.then((execution) => execution.dispose())
        .catch(reportAsyncError);
    }
    desktopAuth.dispose();
    setupSignInRegistration.dispose();
  });
  window.webContents.once('did-finish-load', () => {
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
      const platformInit = await initializeElectronPlatform(desktopMainDir);
      const { lifecycle } = platformInit;
      registerAgentShutdownHandlers(lifecycle);

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
                platformInit.dataRoot,
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
        const openedStreamSnapshotStore = await openDesktopStreamSnapshotStore(
          join(app.getPath('userData'), 'streams.json'),
        );
        streamSnapshotStore = openedStreamSnapshotStore;
        lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () =>
          openedStreamSnapshotStore.flush(),
        );
      } catch (error) {
        console.warn('Failed to open desktop stream snapshot store', error);
      }
      await platformInit.progressSnapshotStore.preload(
        streamSnapshotStore?.hydrated.map((snapshot) => snapshot.streamId) ??
          [],
      );
      reopenMainWindow = () =>
        createWindow({
          workspacePath: platformInit.workspacePath,
          authCoordinator,
          authCallbackState,
          initializeCrashReporting,
          lifecycle,
          streamSnapshotStore,
          progressSnapshotStore: platformInit.progressSnapshotStore,
          hasPriorInstall: platformInit.hasPriorInstall,
          resourcesPath: platformInit.resourcesPath,
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
