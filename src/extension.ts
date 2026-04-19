// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import dotenv from 'dotenv';

// Local imports - core
import { loadAgents, setAgentDirectories } from '@agent/index';
import { clearStoreCache } from '@agent/storage';
import { initPlatform } from '@platform/platform';
import { killBackgroundProcesses } from '@agent/runtime/executionRegistry';
import { initializePolishModel } from '@agent/runtime/polishModel';
import { initializeServerSideKeyAccess } from '@auth/serverKeys';
import { SupabaseClient } from '@auth/SupabaseClient';
import { SupabaseAuthProvider } from '@auth/SupabaseAuthProvider';
import { SupabaseUriHandler } from '@auth/UriHandler';
import { isSupabaseConfigured, setRuntimeExtensionId } from '@auth/config';
import { toErrorMessage } from '@common/errors';
import {
  getActiveSidebarView,
  SIDEBAR_VIEWS,
  setActiveSidebarView,
} from '@common/webview';
import {
  initializeStateManagers,
  workspaceSM,
  WorkspaceStateKey,
} from '@common/state';
import { isTerminalStatus } from '@common/constants/streamStatus';
import { bus } from '@eventBus/ProgressEventBus';
import { SecretManager } from '@frontend/secretManager';
import {
  copyDefaultAgents,
  configureLatexSettings,
  initializeToolDefaults,
  refreshModelListIfNeeded,
} from '@frontend/setup';
import { agentDirectories } from '@frontend/agents';
import { FileLister } from '@frontend/files';
import { killActiveRecording } from '@frontend/media/audio';
import { disposeDiffRefresh } from '@frontend/ui/diffView';
import { initializeNativeToolEditApproval } from '@frontend/approval/nativeToolEditApproval';
import { registerAgentEventListeners } from '@frontend/events/agentEventListeners';
import * as leanVscodeIntegration from '@frontend/lean/VscodeIntegration';
import { applyGitAuthorConfig } from '@frontend/git/gitAuthorSetup';
import * as logger from '@logger/logUtils';
import { UsageLogService } from '@logger/UsageLogService';
import { STREAM_STATUS, type StreamStatus } from '@shared/schemas';
import { interruptAllCodexSessions } from '@tools/codex';
import { setExtensionChecker } from '@tools/externalToolDefs';
import { setGitHubTokenProvider, prPollingSource } from '@tools/github';
import { setToolNotificationHandler } from '@tools/toolUnavailableNotification';
import { setLeanVscodeServices } from '@tools/lean/leanVscodeServices';
import { setLinterProvider } from '@tools/DiagnosticsTool';
import { setOpenBuildDisplay } from '@tools/approval/latexPreview';
import { getLinterMessages } from '@frontend/latex/linter';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { StorageFS } from '@utils/files';
import { getConfig } from '@utils/config';
import { TASK_RUNS_DIR } from '@utils/files/taskRunStorage';
import { VscodeFileSystem } from '@frontend/vscode/vscodeFileSystem';
import { VscodeWorkspace } from '@frontend/vscode/vscodeWorkspace';
import { VscodeStorage } from '@frontend/vscode/vscodeStorage';
import { VscodeSecrets } from '@frontend/vscode/vscodeSecrets';

// Local imports - components
import { ProgressViewProvider } from './progressView/ProgressViewProvider';
import { registerCommands, getMainViewProvider } from './commands';
import { registerFileDecorations } from './fileDecorations';
import { registerWelcomeView } from './welcomeView';

let statusBarItem: vscode.StatusBarItem | undefined;
let apiKeyStatusBarItem: vscode.StatusBarItem | undefined;
let disposeStatusListener: (() => void) | undefined;
let progressViewProviderInstance: ProgressViewProvider | undefined;

async function refreshApiKeyStatus() {
  if (!apiKeyStatusBarItem) {
    return;
  }

  // Check if reminders are enabled
  const showReminders = getConfig<boolean>(
    'texra.ui.showApiKeyReminders',
    true,
  );

  if (!showReminders) {
    apiKeyStatusBarItem.hide();
    return;
  }

  const exists = await SecretManager.anyApiKeyExists();
  if (!exists) {
    apiKeyStatusBarItem.text = '$(warning) TeXRA: API Key Required';
    apiKeyStatusBarItem.tooltip = 'No API keys configured — click to set up';
    apiKeyStatusBarItem.command = 'texra.setApiKey';
    apiKeyStatusBarItem.show();
  } else {
    apiKeyStatusBarItem.hide();
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;

  if (!workspaceFolders || workspaceFolders.length !== 1) {
    registerWelcomeView(context);
    return;
  }
  const workspaceRoot = workspaceFolders[0].uri.fsPath;
  await vscode.commands.executeCommand('setContext', 'texra.activated', true);

  dotenv.config({
    path: path.join(workspaceRoot, '.env'),
  });
  await setActiveSidebarView(SIDEBAR_VIEWS.MAIN);

  SecretManager.initialize(context);
  agentDirectories.initialize(context);
  setAgentDirectories(agentDirectories);
  initializePolishModel(context.extensionPath);
  initializeStateManagers(context);
  initPlatform({
    config: { get: getConfig },
    globalState: context.globalState,
    workspaceState: context.workspaceState,
    log: logger,
    fs: new VscodeFileSystem(),
    workspace: new VscodeWorkspace(),
    storage: new VscodeStorage(context),
    secrets: new VscodeSecrets(context),
  });
  await StorageFS.ensureDir(TASK_RUNS_DIR);
  FileLister.initialize(context);
  initializeServerSideKeyAccess(context, {
    isAuthenticated: () => SupabaseClient.isAuthenticated(),
    getUserTier: () => SupabaseClient.getUserTier(),
    getAccessToken: () => SupabaseClient.getAccessToken(),
  });

  // Seed first-install defaults (e.g. disabled tools) before anything writes
  // LAST_KNOWN_VERSION, so upgrading users are not affected.
  await initializeToolDefaults();

  // Copy default agents before loading the agent index so built-in agents
  // are available when the index scans directories
  await copyDefaultAgents(context);
  await refreshModelListIfNeeded();

  loadAgents().catch((err) => {
    logger.error(
      'extension',
      `Failed to initialize agent index: ${toErrorMessage(err)}`,
    );
  });

  try {
    setRuntimeExtensionId(context.extension.id);

    if (!isSupabaseConfigured()) {
      logger.warn(
        'extension',
        'Supabase authentication is enabled but credentials are not configured. Please configure credentials in src/auth/config.ts before building.',
      );
    } else {
      const authProvider = new SupabaseAuthProvider(context);
      context.subscriptions.push(
        vscode.authentication.registerAuthenticationProvider(
          'texra-supabase',
          'TeXRA Account',
          authProvider,
          { supportsMultipleAccounts: false },
        ),
      );

      const uriHandler = new SupabaseUriHandler();
      context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));
      authProvider.setUriHandler(uriHandler);
      SupabaseClient.setVSCodeProviderRegistered();

      logger.info('extension', 'Supabase authentication provider registered');

      try {
        const extensionVersion =
          typeof context.extension.packageJSON?.version === 'string'
            ? context.extension.packageJSON.version
            : undefined;
        const editorType = vscode.env.appName || undefined;
        UsageLogService.initialize({}, extensionVersion, editorType);
        context.subscriptions.push({
          dispose: () => void UsageLogService.dispose(),
        });
      } catch (usageError) {
        logger.warn(
          'extension',
          `Usage logging service failed to initialize: ${toErrorMessage(usageError)}`,
        );
      }
    }
  } catch (error) {
    const initError =
      error instanceof Error ? error : new Error(toErrorMessage(error));
    SupabaseClient.setInitError(initError);
    logger.error(
      'extension',
      `Failed to initialize Supabase authentication: ${toErrorMessage(error)}`,
    );
  }

  const progressViewProvider = new ProgressViewProvider(context);
  progressViewProviderInstance = progressViewProvider;
  await progressViewProvider.initialize();

  logger.info('extension', 'TeXRA extension activated');

  await progressViewProvider.cleanupTasksAfterRestart();
  configureLatexSettings();
  registerCommands(context);
  registerFileDecorations(context);

  initializeNativeToolEditApproval(context);
  setLeanVscodeServices(leanVscodeIntegration);
  setExtensionChecker((id) => vscode.extensions.getExtension(id) !== undefined);
  // GitHub token lives in SecretStorage (managed via the Git settings tab).
  // The tool layer only supports a synchronous token lookup, so we cache here
  // and refresh on secret changes.
  let cachedGitHubToken: string | undefined;
  const refreshGitHubToken = async () => {
    cachedGitHubToken = await SecretManager.getGitHubToken();
  };
  setGitHubTokenProvider(() => cachedGitHubToken);
  void refreshGitHubToken();
  context.subscriptions.push(
    context.secrets.onDidChange((e) => {
      if (e.key === SecretManager.GITHUB_TOKEN_KEY) {
        void refreshGitHubToken();
      }
    }),
  );
  const disposeGitHubAuthListener = bus.on(
    'githubTokenInvalid',
    ({ message }) => {
      void vscode.window
        .showErrorMessage(
          `GitHub token rejected: ${message}`,
          'Open Git settings',
        )
        .then((choice) => {
          if (choice === 'Open Git settings') {
            void vscode.commands.executeCommand('texra.showGitSettings');
          }
        });
    },
  );
  context.subscriptions.push({ dispose: disposeGitHubAuthListener });
  setLinterProvider(getLinterMessages);
  setOpenBuildDisplay(openBuildDisplayIfTex);
  applyGitAuthorConfig();

  setToolNotificationHandler((message, actionCommand, actionLabel) => {
    if (actionCommand) {
      const label = actionLabel ?? 'Open Tools Dashboard';
      void vscode.window
        .showInformationMessage(message, label)
        .then((choice) => {
          if (choice === label) {
            void vscode.commands.executeCommand(actionCommand);
          }
        });
    } else {
      void vscode.window.showInformationMessage(message);
    }
  });

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
  );
  statusBarItem.command = 'texra.showProgressView';
  statusBarItem.text = '$(bracket-dot) TeXRA: Idle';
  statusBarItem.tooltip = 'Show TeXRA Tasks';
  statusBarItem.show();

  apiKeyStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
  );
  context.subscriptions.push(apiKeyStatusBarItem);
  void refreshApiKeyStatus().catch((err) =>
    logger.error(
      'extension',
      `API key status refresh failed: ${toErrorMessage(err)}`,
    ),
  );

  const runningStreams = new Set<string>();
  const updateStatusBarText = () => {
    const count = runningStreams.size;
    if (count > 1) {
      statusBarItem!.text = `$(loading) TeXRA: ${count} active`;
    } else if (count === 1) {
      statusBarItem!.text = '$(loading) TeXRA: Running';
    } else {
      statusBarItem!.text = '$(bracket-dot) TeXRA: Idle';
    }
  };

  disposeStatusListener = bus.on(
    'updateStreamStatus',
    ({ streamId, status }: { streamId: string; status: StreamStatus }) => {
      if (status === STREAM_STATUS.RUNNING) {
        runningStreams.add(streamId);
      } else if (isTerminalStatus(status)) {
        runningStreams.delete(streamId);
      }
      updateStatusBarText();
    },
  );

  const showMainView = async () => {
    const mvp = getMainViewProvider();
    if (mvp) {
      await mvp.showInSidebar();
      return;
    }
    // Fallback when MainViewProvider is not yet registered
    await setActiveSidebarView(SIDEBAR_VIEWS.MAIN);
    await vscode.commands.executeCommand('texra.mainView.focus');
  };

  const agentEventDisposable = registerAgentEventListeners();

  context.subscriptions.push(
    agentEventDisposable,
    { dispose: disposeStatusListener },
    statusBarItem,
    vscode.commands.registerCommand('texra.showMainView', showMainView),
    vscode.commands.registerCommand('texra.toggleView', async () => {
      const target =
        getActiveSidebarView() === SIDEBAR_VIEWS.MAIN
          ? 'texra.showProgressView'
          : 'texra.showMainView';
      await vscode.commands.executeCommand(target);
    }),
    vscode.commands.registerCommand(
      'texra.refreshApiKeyStatus',
      refreshApiKeyStatus,
    ),
  );

  const mainViewProvider = getMainViewProvider();
  if (mainViewProvider) {
    progressViewProvider.setSidebarWebviewGetter(
      () => mainViewProvider.getWebviewView()?.webview,
    );
    progressViewProvider.setMainViewProvider(mainViewProvider);
    mainViewProvider.setProgressViewProvider(progressViewProvider);
  }

  const welcomeKey = 'texra.welcomeShown';
  if (!context.globalState.get<boolean>(welcomeKey)) {
    // Opening the VS Code walkthrough is enough — don't double up with a
    // popup asking the user to open the walkthrough they just saw.
    void vscode.commands
      .executeCommand('texra.openGettingStarted')
      .then(() => context.globalState.update(welcomeKey, true));
  }
}

export async function deactivate() {
  disposeStatusListener?.();
  killBackgroundProcesses();
  interruptAllCodexSessions();
  killActiveRecording();

  await UsageLogService.dispose();
  await progressViewProviderInstance?.flushState();

  clearStoreCache();
  prPollingSource.disposeAll();
  bus.emit('extensionDeactivating', undefined);

  statusBarItem?.dispose();
  disposeDiffRefresh();
}
