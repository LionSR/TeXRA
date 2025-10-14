// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import dotenv from 'dotenv';

// Local imports - core
import * as logger from '@logger/logUtils';
import { watchConfig, getConfig } from '@utils/config';
import { SecretManager } from '@frontend/secretManager';
import { copyDefaultAgents, configureLatexSettings } from '@frontend/setup';
import { disposeDiffRefresh } from '@frontend/ui/diffView';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { StorageFS } from '@utils/files';
import { TASK_RUNS_DIR } from '@utils/files/taskRunStorage';
import { initializeStateManagers } from '@common/state/stateManager';
import { FileLister } from '@frontend/files/fileLister';
import { bus } from '@eventBus/ProgressEventBus';
import { ToolUseSessionManager } from '@agent/toolUse/ToolUseSessionManager';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';
import { computeAgentOptions } from '@agent/computeAgentOptions';

// Local imports - components
import { ProgressViewProvider } from './progressView/ProgressViewProvider';
import { FolderExplorer } from './FolderExplorer';
import { ExplorerOperations } from './explorer/ExplorerOperations';
import { ExplorerCommands } from './explorer/ExplorerCommands';
import { WatcherManager } from './explorer/WatcherManager';
import { registerCommands } from './commands';
import { registerAuthCommands } from '@commands/auth/authCommands';
import {
  AuthController,
  type AuthStatePayload,
} from '@frontend/auth/AuthController';

let statusBarItem: vscode.StatusBarItem | undefined;
let apiKeyStatusBarItem: vscode.StatusBarItem | undefined;
let disposeStatusListener: (() => void) | undefined;
let authStatusBarItem: vscode.StatusBarItem | undefined;
let proxyStatusBarItem: vscode.StatusBarItem | undefined;
let authStateSubscription: vscode.Disposable | undefined;
let authControllerInstance: AuthController | undefined;
let latestAuthState: AuthStatePayload | undefined;

function promptToOpenFolder(message: string): void {
  const openAction = 'Open Folder';
  void vscode.window
    .showInformationMessage(message, openAction)
    .then((choice) => {
      if (choice === openAction) {
        void vscode.commands.executeCommand(
          'workbench.action.files.openFolder',
        );
      }
    });
}

async function refreshApiKeyStatus() {
  if (!apiKeyStatusBarItem) {
    return;
  }

  // Check if reminders are enabled
  const showReminders = getConfig<boolean>('ui.showApiKeyReminders', true);

  if (!showReminders) {
    apiKeyStatusBarItem.hide();
    return;
  }

  if (latestAuthState?.proxyEnabled) {
    apiKeyStatusBarItem.hide();
    return;
  }

  const exists = await SecretManager.anyApiKeyExists();
  if (!exists) {
    apiKeyStatusBarItem.text = '$(warning) TeXRA: API Key Required';
    apiKeyStatusBarItem.command = 'texra.setApiKey';
    apiKeyStatusBarItem.show();
  } else {
    apiKeyStatusBarItem.hide();
  }
}

function updateAuthStatusBar(state?: AuthStatePayload) {
  if (!authStatusBarItem || !proxyStatusBarItem) {
    return;
  }

  if (!state?.signedIn) {
    authStatusBarItem.text = '$(account) TeXRA: Sign In';
    authStatusBarItem.command = 'texra.auth.signIn';
    authStatusBarItem.tooltip =
      'Sign in to unlock TeXRA remote agents and proxy access.';
    authStatusBarItem.show();

    proxyStatusBarItem.text = '$(cloud-off) TeXRA: Proxy Locked';
    proxyStatusBarItem.command = 'texra.auth.signIn';
    proxyStatusBarItem.tooltip =
      'Proxy routing requires a TeXRA account with proxy access.';
    proxyStatusBarItem.show();
    return;
  }

  authStatusBarItem.text = '$(account) TeXRA: Account Ready';
  authStatusBarItem.command = 'texra.auth.signOut';
  authStatusBarItem.tooltip = 'Sign out of your TeXRA account.';
  authStatusBarItem.show();

  if (state.proxyEnabled) {
    proxyStatusBarItem.text = '$(cloud-upload) TeXRA: Proxy Ready';
    proxyStatusBarItem.command = 'texra.auth.refreshSession';
    const expiresAt = state.proxyExpiresAt
      ? new Date(state.proxyExpiresAt).toLocaleString()
      : undefined;
    proxyStatusBarItem.tooltip = expiresAt
      ? `Proxy session active. Expires ${expiresAt}.`
      : 'Proxy session active.';
    proxyStatusBarItem.show();
  } else {
    proxyStatusBarItem.text = '$(cloud-off) TeXRA: Proxy Requires Login';
    proxyStatusBarItem.command = 'texra.auth.signIn';
    proxyStatusBarItem.tooltip =
      'Your account is signed in but proxy access is unavailable. Contact support if this is unexpected.';
    proxyStatusBarItem.show();
  }
}

async function syncAuthBanner(state?: AuthStatePayload) {
  try {
    const view = await vscode.commands.executeCommand<vscode.WebviewView>(
      'texra.getWebviewView',
    );
    if (!view) {
      return;
    }

    await view.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.SHOW_AUTH_BANNER,
      signedIn: state?.signedIn ?? false,
      proxyEnabled: state?.proxyEnabled ?? false,
      message: state?.signedIn
        ? state?.proxyEnabled
          ? 'Connected to TeXRA. Proxy routing is ready.'
          : 'Signed in. Proxy access pending or unavailable.'
        : undefined,
    });

    if (state?.proxyEnabled) {
      await view.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER,
      });
    }
  } catch (err) {
    console.error('Failed to synchronize auth banner', err);
  }
}

async function refreshAgentDropdown(
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    const agentOptions = await computeAgentOptions(context);
    const view = await vscode.commands.executeCommand<vscode.WebviewView>(
      'texra.getWebviewView',
    );
    view?.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      options: agentOptions,
    });
  } catch (err) {
    console.error('Failed to refresh agent options', err);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    promptToOpenFolder(
      'TeXRA requires an open workspace. Please open a folder to enable the extension.',
    );
    return; // Exit before further initialization
  } else if (workspaceFolders.length > 1) {
    promptToOpenFolder(
      'TeXRA supports only a single-folder workspace. Please open one folder to enable the extension.',
    );
    return;
  }
  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  dotenv.config({
    path: path.join(workspaceRoot, '.env'),
  });

  // Initialize storage systems
  SecretManager.initialize(context);
  StorageFS.initialize(context);
  agentDirectories.initialize(context);
  await StorageFS.ensureDir(TASK_RUNS_DIR);
  initializeStateManagers(context);
  FileLister.initialize(context);

  authControllerInstance = new AuthController(context);
  await authControllerInstance.initialize();
  registerAuthCommands(context, authControllerInstance);
  latestAuthState = authControllerInstance.getState();
  authStateSubscription = authControllerInstance.onDidChangeState((state) => {
    latestAuthState = state;
    updateAuthStatusBar(state);
    refreshApiKeyStatus().catch(console.error);
    syncAuthBanner(state).catch(console.error);
    refreshAgentDropdown(context).catch(console.error);
  });
  context.subscriptions.push(
    { dispose: () => authStateSubscription?.dispose() },
    { dispose: () => authControllerInstance?.dispose() },
  );

  // Create the log view provider
  const progressViewProvider = new ProgressViewProvider(context);
  await progressViewProvider.initialize();

  const persistedToolUseSessions = ToolUseSessionManager.isPersistenceEnabled()
    ? await ToolUseSessionManager.listSnapshots()
    : [];
  ToolUseSessionManager.registerPendingSnapshots(persistedToolUseSessions);
  const waitingStreams = new Set(
    persistedToolUseSessions.map((snapshot) => snapshot.streamId),
  );

  // Log activation message to ensure the logger is working correctly
  logger.info('extension', 'TeXRA extension activated');

  // Clean up any tasks that were left in "running" state from previous session
  await progressViewProvider.cleanupTasksAfterRestart(waitingStreams);

  // Copy default agents
  await copyDefaultAgents(context);

  // Configure LaTeX settings if LaTeX Workshop is installed
  configureLatexSettings();

  // Register commands first - this will create and store the MainViewProvider
  registerCommands(context);

  // Create a status bar item to show TeXRA progress
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
  );
  statusBarItem.command = 'texra.showProgressView';
  statusBarItem.text = 'TeXRA: Idle';
  statusBarItem.show();

  apiKeyStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
  );
  context.subscriptions.push(apiKeyStatusBarItem);
  // Non-blocking refresh to avoid delaying extension activation
  refreshApiKeyStatus().catch(console.error);

  authStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
  );
  proxyStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
  );
  context.subscriptions.push(authStatusBarItem, proxyStatusBarItem);
  updateAuthStatusBar(latestAuthState);
  syncAuthBanner(latestAuthState).catch(console.error);

  const runningStreams = new Set<string>();
  const NON_RUNNING_STATUSES = ['stopped', 'error', 'cancelled', 'waiting'];

  disposeStatusListener = bus.on(
    'updateStreamStatus',
    ({ stream, status }: { stream: string; status: string }) => {
      if (status === 'running') {
        runningStreams.add(stream);
      } else if (NON_RUNNING_STATUSES.includes(status)) {
        runningStreams.delete(stream);
      }
      statusBarItem!.text =
        runningStreams.size > 0 ? 'TeXRA: Running' : 'TeXRA: Idle';
    },
  );

  context.subscriptions.push(
    { dispose: disposeStatusListener },
    statusBarItem,
    vscode.commands.registerCommand(
      'texra.refreshApiKeyStatus',
      refreshApiKeyStatus,
    ),
  );

  // Register the folder explorer with context
  const folderExplorer = new FolderExplorer(workspaceRoot, context);
  const explorerOps = new ExplorerOperations(workspaceRoot, context, () =>
    folderExplorer.refresh(),
  );
  const commandManager = new ExplorerCommands(context, explorerOps);
  commandManager.register();
  const watcherManager = new WatcherManager(context, () =>
    folderExplorer.refresh(),
  );
  await watcherManager.setup();

  // Register the tree data provider and webview providers
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'texra.progressView',
      progressViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } }, // Keep the webview alive even when hidden
    ),
    // Removed duplicate mainViewProvider registration since it's handled in commands.ts
    vscode.window.registerTreeDataProvider(
      'texra.folderExplorer',
      folderExplorer,
    ),
    // Add disposable for cleanup
    { dispose: () => watcherManager.dispose() },
  );

  // Watch for agents directory changes
  watchConfig(context, 'texra.explorer.agentsDirectory', () => {
    watcherManager.setup();
    folderExplorer.refresh();
  });

  const welcomeKey = 'texra.welcomeShown';
  if (!context.globalState.get<boolean>(welcomeKey)) {
    void showInstructionWithSuppress(
      'welcome',
      'Welcome to TeXRA! Run "TeXRA: Create Sample Project" to add a draft.tex example, set your API keys, choose an agent and model, then write instructions and execute.',
      [
        {
          title: 'Open Guide',
          callback: async () => {
            await vscode.env.openExternal(
              vscode.Uri.parse('https://texra.ai/guide/'),
            );
          },
        },
        {
          title: 'Create Sample Project',
          callback: async () => {
            await vscode.commands.executeCommand('texra.createSampleProject');
          },
        },
      ],
    )
      .then(() => context.globalState.update(welcomeKey, true))
      .catch(console.error);
  }
}

export async function deactivate() {
  disposeStatusListener?.();

  // Clean up persisted tool-use sessions when extension deactivates
  await ToolUseSessionManager.deleteAllSnapshots();

  // Get the ProgressViewProvider instance
  const progressViewProvider = ProgressViewProvider.getInstance();
  if (progressViewProvider) {
    // Mark all running tasks as cancelled when extension deactivates
    progressViewProvider.eventHandler.markAllRunningTasksAsCancelled();
  }
  statusBarItem?.dispose();
  disposeDiffRefresh();
}
