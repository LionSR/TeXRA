import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
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

import { runInSession } from '@agent/runtime';
import {
  computeAgentOptionsData,
  getAgent,
  getAgentsByCategory,
  getVisibleAgents,
  loadAgents,
  refresh,
} from '@agent/index';
import { SupabaseClient } from '@auth/SupabaseClient';
import {
  teamAvailabilityPrompt,
  type TeamAvailabilityPrompt,
} from '@common/teams/TeamPlan';
import { LatexToolingController } from '@controllers/settingsView/LatexToolingController';
import { prepareMainViewExecutionRequest } from '@controllers/mainView/MainViewExecutionController';
import { SubscriptionUsageService } from '@controllers/modelAccess/subscriptionUsage/SubscriptionUsageService';
import { createLog } from '@logger/logUtils';
import { hasUsableSetupCredential } from '@model/setupCredentialAccess';
import { platform } from '@platform/platform';
import { DisposableStore } from '@platform/disposable';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import {
  AgentCategory,
  agentKeyOf,
  INSTRUCTION_ACTION,
  type AgentSource,
  type InstructionAction,
} from '@shared/schemas';
import { normalizePlatform } from '@shared/constants/latexToolchain';
import { registerRuntimeShutdownHandlers } from '@tools/agentCliSessionStores';
import {
  getLastCheckResults,
  refreshToolAvailability,
} from '@tools/toolAvailability';
import { killActiveRecording } from '@tools/media/audio';
import { ephemeralTranscriptWarning } from '@transcript';
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
import {
  createDesktopFileSelection,
  type DesktopFileSelection,
} from './desktopFileSelection.js';
import {
  openDesktopPaperRegistry,
  readRememberedDesktopPapers,
  type DesktopPaper,
  type DesktopPaperRegistry,
} from './desktopPapers.js';
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
  EMPTY_DESKTOP_ENVIRONMENT_SUMMARY,
} from '../shared/desktopWorkspaceMessages.js';
import {
  DESKTOP_PAPER_COMMANDS,
  DesktopClosePaperMessageSchema,
  DesktopSelectPaperMessageSchema,
} from '../shared/desktopPaperMessages.js';
import { createCommandHandler } from './desktopIpcTypes.js';
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
  type DesktopSettingsIpc,
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
import {
  DESKTOP_DOCS_URL,
  postDesktopSettingsView,
} from '../shared/desktopCommandSurface.js';
import type { DesktopProgressBridge } from './desktopAgentExecution.js';
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

/** Warn once a window exists when a paper's transcripts could not persist. */
function warnIfEphemeral(paper: DesktopPaper): void {
  const { mode } = paper.session.transcripts;
  if (mode.kind !== 'ephemeral') return;
  void showDesktopWarningDialog(ephemeralTranscriptWarning(mode.reason)).catch(
    (error: unknown) => console.error(error),
  );
}

function createWindow(options: {
  papers: DesktopPaperRegistry;
  authCoordinator: DesktopAuthCoordinator;
  authCallbackState: DesktopAuthCallbackState;
  /** See ElectronPlatformInitResult.resourcesPath. */
  resourcesPath: string;
}): void {
  const activePaper = () => options.papers.active();
  const initialPaper = activePaper();
  const initialWindowTitle = getDesktopWindowTitle(
    initialPaper.session,
    initialPaper.root,
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
  // Paper root: every resource bound to the paper the window shows (its
  // title, its settings surface, its progress bridge) registers here and is
  // replaced when the window switches papers.
  let paperResources = new DisposableStore();
  let attachedPaper: DesktopPaper | undefined;
  windowResources.add(() => {
    const paper = attachedPaper;
    attachedPaper = undefined;
    if (paper) void runInSession(paper.session, () => paperResources.dispose());
    else paperResources.dispose();
  });
  // The paper switch the renderer asked for (show another root, or close the
  // shown one); lands once the renderer has reloaded (a dirty editor can veto
  // the reload and clear it).
  let pendingPaperActivation: string | undefined;
  let pendingPaperClose: string | undefined;
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
    current?: DesktopSettingsIpc;
  } = {};
  const fileSelectionRef: {
    current?: DesktopFileSelection;
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
  const chooseTeamAvailability = (
    unavailableNames: readonly string[],
    presetName?: string,
  ) =>
    presentTeamAvailabilityPrompt(
      teamAvailabilityPrompt(unavailableNames, presetName),
    );
  // Lightweight update check: at most once/day, notifies at most once per
  // release via a native dialog linking to the GitHub release page. Not a full
  // updater: no download, no install, no feed files. Disable with
  // TEXRA_NO_UPDATE_CHECK=1. `createWindow` only ever runs inside the
  // `app.whenReady()` block, which the lock-losing process never reaches, so
  // no extra single-instance gate is needed here; `checkForDesktopUpdate`
  // itself dedupes concurrent calls and window reopens.
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
  // Button labels for the instruction dialog below. Desktop has one settings
  // home (Settings tab), so SET_API_KEY opens it directly rather than the
  // extension's separate "enter a key" quick pick.
  const INSTRUCTION_ACTION_BUTTON_LABELS: Record<InstructionAction, string> = {
    [INSTRUCTION_ACTION.SET_API_KEY]: 'Set API Key',
    [INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE]: 'Configuration Guide',
    [INSTRUCTION_ACTION.OPEN_MODELS_DOC]: 'Model Documentation',
  };
  const dispatchInstructionAction = (action: InstructionAction): void => {
    switch (action) {
      case INSTRUCTION_ACTION.SET_API_KEY:
        postDesktopSettingsView(postToRendererIfAlive, 'models');
        return;
      case INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE:
        previewHost
          .openExternal('https://texra.ai/guide/configuration.html')
          .catch(reportBackgroundError);
        return;
      case INSTRUCTION_ACTION.OPEN_MODELS_DOC:
        previewHost
          .openExternal('https://texra.ai/guide/models.html')
          .catch(reportBackgroundError);
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
  const folderPickerDefaultPath = () =>
    activePaper().root ?? app.getPath('home');

  /**
   * Show another open paper. The renderer reloads into it: the
   * will-prevent-unload handler below clears the request when the user keeps
   * a dirty editor, and the reload's navigation commits it otherwise.
   */
  const selectPaper = (root: string) => {
    if (root === activePaper().root) return;
    if (!options.papers.list().some((paper) => paper.root === root)) return;
    pendingPaperActivation = root;
    window.webContents.reload();
  };

  /**
   * Close an open paper. A paper the window is not showing closes at once;
   * the shown one closes through the same reload as a switch, so a dirty
   * editor can keep it open, and the registry moves the window to the paper
   * shown before it.
   */
  const closePaper = (root: string) => {
    if (!options.papers.list().some((paper) => paper.root === root)) return;
    if (root !== activePaper().root) {
      void options.papers.close(root).catch(reportAsyncError);
      return;
    }
    pendingPaperClose = root;
    window.webContents.reload();
  };

  const openWorkspaceFolder = async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Open Workspace Folder',
      defaultPath: folderPickerDefaultPath(),
      properties: ['openDirectory'],
    });
    const selectedPath = result.canceled ? undefined : result.filePaths[0];
    if (!selectedPath) return;
    const paper = await options.papers.open(selectedPath);
    warnIfEphemeral(paper);
    if (paper.root !== undefined) selectPaper(paper.root);
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
    // Recompute the onboarding funnel after a run completes so a user's first
    // successful run leaves the setup card without waiting for a restart
    // (the run lifecycle has already persisted firstRunDone). Mirrors the
    // extension's post-run refresh hooks in MainViewMessageHandler.
    onRunCompleted: () => {
      void onboardingIpcRef.current?.refreshOnboardingFunnel();
    },
  };
  // One progress bridge per paper, created lazily for the paper the window
  // shows and released when the window switches papers or closes. The
  // session outlives it; reattachment replays through `interactions.use`.
  let agentExecution: DesktopProgressBridge | undefined;
  let agentExecutionLoad: Promise<DesktopProgressBridge> | undefined;
  // Aborted when the bridge is released: the signal is both the presentation
  // cancellation token and the bridge's "gone" fact.
  let presentationAbort = new AbortController();
  const releaseAgentExecution = () => {
    // Abort first, cancelling an in-flight lazy load.
    presentationAbort.abort();
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
    agentExecution = undefined;
    agentExecutionLoad = undefined;
    presentationAbort = new AbortController();
  };
  const getAgentExecution = async (): Promise<DesktopProgressBridge> => {
    if (agentExecution) return agentExecution;
    const abort = presentationAbort;
    if (abort.signal.aborted) {
      throw new Error(
        'Cannot load desktop agent execution after window close.',
      );
    }

    if (!agentExecutionLoad) {
      const paper = activePaper();
      const load: Promise<DesktopProgressBridge> = Promise.resolve(
        runInSession(paper.session, () =>
          import('./desktopAgentExecution.js').then(
            async ({ createDesktopAgentExecution }) => {
              const created = await createDesktopAgentExecution({
                postToRenderer: postToRendererIfAlive,
                host: agentExecutionHost,
                session: paper.session,
                sessionStores: paper.stores,
                resourcesPath: options.resourcesPath,
                presentationSignal: abort.signal,
              });
              if (abort.signal.aborted) {
                created.dispose();
                throw new Error(
                  'Desktop window closed before agent execution finished loading.',
                );
              }
              agentExecution = created;
              return created;
            },
          ),
        ),
      ).catch((error: unknown) => {
        if (agentExecutionLoad === load) agentExecutionLoad = undefined;
        throw error;
      });
      agentExecutionLoad = load;
    }
    return agentExecutionLoad;
  };
  const subscriptionUsage = new SubscriptionUsageService();
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
  const requireSettingsIpc = (): DesktopSettingsIpc => {
    const settingsIpc = settingsIpcRef.current;
    if (!settingsIpc) throw new Error('Desktop settings IPC is not attached.');
    return settingsIpc;
  };
  const postPapers = () => {
    postToRendererIfAlive({
      command: DESKTOP_PAPER_COMMANDS.PAPERS,
      ...options.papers.summary(),
    });
  };
  /**
   * Bind the window to the paper it shows. The settings controllers read the
   * paper's workspace state and config, the settings surface subscribes to
   * the paper's session (goal facts, approval policy), the title follows its
   * activity, the file lists scan its root, and the progress bridge is built
   * lazily for it; all of them are released when the window switches papers.
   */
  const attachActivePaper = () => {
    const paper = activePaper();
    if (paper === attachedPaper) return;
    const previous = attachedPaper;
    const previousResources = paperResources;
    attachedPaper = paper;
    paperResources = new DisposableStore();
    if (previous) {
      void runInSession(previous.session, () => previousResources.dispose());
    }
    paperResources.add(
      installDesktopWindowTitle(window, paper.session, paper.root),
    );
    const agentSettingsController = new DefaultDesktopAgentSettingsController({
      workspaceState: paper.roots.workspaceState,
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
            defaultPath: folderPickerDefaultPath(),
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
        chooseTeamAvailability: presentTeamAvailabilityPrompt,
      },
      remoteCatalog: {
        canAccess: () => SupabaseClient.isAuthenticated(),
        signIn: signInForRemoteAgentCatalog,
      },
      notifications: { showInfoMessage, showErrorMessage },
      resourcesPath: options.resourcesPath,
    });
    const credentialSettingsController =
      new DefaultDesktopCredentialSettingsController({
        workspaceState: paper.roots.workspaceState,
        globalState: platform().globalState,
        config: paper.roots.config,
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
        // Credential operations already show their specific failure dialog. Keep
        // the shared callback log-only so one failure never opens a second,
        // generic desktop-operation dialog.
        onError: reportBackgroundError,
      });
    const toolingSettingsController =
      new DefaultDesktopToolingSettingsController({
        onError: reportAsyncError,
        workspaceState: paper.roots.workspaceState,
        globalState: platform().globalState,
        config: paper.roots.config,
        renderer: {
          postToRenderer: postToRendererIfAlive,
        },
        dashboard: {
          buildItems: async (cachedResults) => {
            const { buildToolDashboardItems } =
              await import('@controllers/settingsView/ToolDashboardData');
            return buildToolDashboardItems('desktop', cachedResults);
          },
          getCachedCheckResults: async () => getLastCheckResults() ?? undefined,
          refreshAvailability: refreshToolAvailability,
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
      });
    paperResources.add(() => toolingSettingsController.dispose());
    const settingsIpc = createDesktopSettingsIpc({
      postToRenderer: postToRendererIfAlive,
      agentSettingsController,
      credentialSettingsController,
      toolingSettingsController,
      globalState: platform().globalState,
      ui: settingsUi,
      session: paper.session,
    });
    settingsIpcRef.current = settingsIpc;
    // Holds paper-scoped subscriptions (goal state and app signals) that
    // would otherwise accumulate one listener per switch or dock reactivation.
    paperResources.add(() => {
      if (settingsIpcRef.current === settingsIpc) {
        settingsIpcRef.current = undefined;
      }
      settingsIpc.dispose();
    });
    // The file lists belong to the paper: a scan the previous paper started
    // finishes against its own disposed adapter instead of posting into the
    // renderer document this paper has since loaded.
    const fileSelection = createDesktopFileSelection({
      postToRenderer: postToRendererIfAlive,
      workspacePath: paper.root,
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
    fileSelectionRef.current = fileSelection;
    paperResources.add(() => {
      if (fileSelectionRef.current === fileSelection) {
        fileSelectionRef.current = undefined;
      }
      fileSelection.dispose();
    });
    paperResources.add(releaseAgentExecution);
  };
  windowResources.add(
    options.papers.onChange(() => {
      attachActivePaper();
      postPapers();
    }),
  );
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
      hasCredential: () =>
        hasUsableSetupCredential(platform().secrets, credentialLog.warn),
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
        // The paper the user started setup in, taken before the first await:
        // the run and its presentation belong to it even when the window
        // moves to another paper while the model resolves and agents load.
        const paper = activePaper();
        // Initialize the presentation subscription before launch so a fast
        // terminal result is eligible for replay. This await ends before the
        // process-owned run begins and therefore cannot retain the window for
        // the duration of the run.
        await getAgentExecution();
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
        await loadAgents();
        const preparation = prepareMainViewExecutionRequest(message);
        if (!preparation.valid) {
          await showErrorMessage(preparation.message);
          throw new Error(preparation.message);
        }
        return launchDesktopAgent(
          { kind: 'fresh', ...preparation.request },
          { session: paper.session },
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
  // Git reads re-probe the active workspace per request, so workspace
  // switches don't need cache invalidation. Both lambdas map a missing
  // workspace to the host's empty-result convention.
  const getRecentCommits = async () => {
    const workspacePath = activePaper().root;
    if (!workspacePath) {
      return { commits: [] as string[], isGitRepo: false };
    }
    return readRecentCommits(workspacePath, DESKTOP_RECENT_COMMIT_LIMIT, {
      onError: reportBackgroundError,
    });
  };
  const getEnvironmentSummary = async () => {
    const workspacePath = activePaper().root;
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
    cwd: () => activePaper().root,
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
      getWorkspacePath: () => activePaper().root,
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
  // The renderer owns editor dirtiness. This event is the main process's only
  // reading of it: Chromium emits it after the renderer's beforeunload handler
  // observes a dirty Monaco buffer and refuses the unload, so every close path
  // (quit, workspace switch, window close) asks here and nowhere else.
  bootstrapDesktopWindowLifecycle({
    webContents: window.webContents,
    workspaceIpc,
    showDiscardDialog: () =>
      dialog.showMessageBoxSync(window, {
        type: 'warning',
        buttons: ['Keep Editing', 'Discard Changes'],
        defaultId: 0,
        cancelId: 0,
        title: 'Unsaved Changes',
        message: 'This workspace has unsaved editor changes.',
        detail: 'Discard the changes and continue?',
      }),
    isFatalShutdownRequested: isFatalDesktopShutdownRequested,
    clearPendingPaperActivation: () => {
      pendingPaperActivation = undefined;
      pendingPaperClose = undefined;
    },
    commitPendingPaperActivation: () => {
      const root = pendingPaperActivation;
      const closing = pendingPaperClose;
      pendingPaperActivation = undefined;
      pendingPaperClose = undefined;
      if (root !== undefined) options.papers.activate(root);
      if (closing !== undefined) {
        void options.papers.close(closing).catch(reportAsyncError);
      }
    },
    clearContinueQuitAfterWindowClose: () => {
      continueQuitAfterWindowClose = undefined;
    },
  });
  const mainViewIpc = installDesktopMainViewIpc(window, {
    workspace: workspaceIpc,
    handleExecuteMessage: async (message) => {
      const execution = await getAgentExecution();
      void execution.handleExecute(message).catch(reportAsyncError);
    },
    fileSelection: {
      handleMessage: (message) =>
        fileSelectionRef.current?.handleMessage(message) ?? false,
    },
    prompt: promptController,
    settings: {
      handleMessage: (message) =>
        settingsIpcRef.current?.handleMessage(message) ?? false,
    },
    progress: progressIpc,
    onboarding: onboardingIpc,
    papers: createCommandHandler(
      {
        // A broadcast like the progress ready signal: the main view's ready
        // message still reaches the startup handler.
        [MAIN_VIEW_COMMANDS.WEBVIEW_READY]: {
          when: (message) => message.view === 'main',
          run: postPapers,
          claim: false,
        },
        // safeParse, not parse: dispatch runs under `runInSession` with no
        // catch, so a malformed message is dropped, not an unhandled rejection.
        [DESKTOP_PAPER_COMMANDS.SELECT_PAPER]: (message) => {
          const parsed = DesktopSelectPaperMessageSchema.safeParse(message);
          if (parsed.success) selectPaper(parsed.data.root);
        },
        [DESKTOP_PAPER_COMMANDS.CLOSE_PAPER]: (message) => {
          const parsed = DesktopClosePaperMessageSchema.safeParse(message);
          if (parsed.success) closePaper(parsed.data.root);
        },
      },
      { onAsyncError: reportAsyncError },
    ),
    globalState: platform().globalState,
    inActiveSession: (dispatch) => {
      void runInSession(activePaper().session, dispatch);
    },
    logs: {
      readLog: () =>
        readDesktopLogSnapshot({ workspacePath: activePaper().root }),
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
  attachActivePaper();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(buildDesktopMenuTemplate(shellActions)),
  );
  window.once('closed', () => {
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
      let papers!: DesktopPaperRegistry;
      const processResumeOwner = new DesktopProcessResumeOwner({
        sessions: () =>
          [papers.fallback(), ...papers.list()].map((p) => p.session),
      });
      const platformInit = await initializeElectronPlatform(
        desktopMainDir,
        processResumeOwner,
      );
      const { lifecycle } = platformInit;
      // Process root: session-lifetime resources register at creation and are
      // disposed LIFO in the ON phase (every paper's process stores → result
      // toast → session, most recently opened first).
      const processResources = new DisposableStore();
      registerRuntimeShutdownHandlers(lifecycle, {
        beforeAgentShutdown: [() => processResumeOwner.disable()],
        afterAgentShutdown: [() => killActiveRecording()],
        // Agent shutdown runs first so its final events enter the
        // process-owned stores. Flush in BEFORE so persistence cannot be
        // delayed by a later ON-phase language-service disposal.
        flushArtifacts: () => papers.flushArtifacts(),
        // Each window's closed handler starts diff temp-dir removal before the
        // quit lifecycle drains; awaiting idle keeps the process alive until
        // the directories are actually gone.
        afterFlushArtifacts: [() => diffHostDisposeQueue.onIdle()],
        afterExecutionSettlement: [() => processResources.dispose()],
      });

      // Until the initial window is fully wired, any startup failure must run
      // the same process-session shutdown used by an ordinary application
      // exit. Once this block completes, the lifecycle owns that cleanup.
      try {
        const warn = (message: string) => console.warn(`[desktop] ${message}`);
        papers = await openDesktopPaperRegistry({
          dataRoot: platformInit.dataRoot,
          processRoots: platformInit.processRoots,
          globalConfigStore: platformInit.globalConfigStore,
          globalState: platform().globalState,
          warn,
        });
        processResources.add(() => papers.dispose());
        // Reopen every folder left open last time and show the one shown
        // last. A folder that is gone or no longer opens is reported once the
        // window exists; the others open regardless.
        const remembered = await readRememberedDesktopPapers(
          platform().globalState,
          warn,
        );
        const unopenedPapers = remembered.missing.map(
          (root) => `${root} (no such folder; forgotten)`,
        );
        for (const root of remembered.roots) {
          try {
            await papers.open(root);
          } catch (error) {
            unopenedPapers.push(`${root}: ${toErrorMessage(error)}`);
          }
        }
        papers.activate(papers.list().at(-1)?.root);
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
            ...papers.list().map((paper) => paper.root),
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
            papers,
            authCoordinator,
            authCallbackState,
            resourcesPath: platformInit.resourcesPath,
          });
        reopenMainWindow();
        // The active paper is in the list unless it is the no-workspace
        // session; the set keeps it to one dialog either way.
        for (const paper of new Set([papers.active(), ...papers.list()])) {
          warnIfEphemeral(paper);
        }
        if (unopenedPapers.length > 0) {
          void showDesktopWarningDialog(
            `Some papers could not be reopened:\n${unopenedPapers.join('\n')}`,
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
  if (process.platform !== 'darwin') app.quit();
});
