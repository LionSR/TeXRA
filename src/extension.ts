// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import dotenv from 'dotenv';

// Local imports - core
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import { initializeStateManagers } from '@common/state/stateManager';
import { SecretManager } from '@frontend/secretManager';
import {
  copyDefaultAgents,
  configureLatexSettings,
  refreshModelListIfNeeded,
} from '@frontend/setup';
import { FileLister } from '@frontend/files';
import { agentDirectories } from '@frontend/agents';
import { disposeDiffRefresh } from '@frontend/ui/diffView';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import * as logger from '@logger/logUtils';
import { UsageLogService } from '@logger/UsageLogService';
import { initializeToolEditApproval } from '@tools/approval/toolEditApproval';
import { StorageFS } from '@utils/files';
import { watchConfig, getConfig } from '@utils/config';
import { TASK_RUNS_DIR } from '@utils/files/taskRunStorage';
import { bus } from '@eventBus/ProgressEventBus';
import { initializeServerSideKeyAccess } from '@/auth/serverKeys';
import { SupabaseClient } from '@/auth/SupabaseClient';

// Local imports - components
import { ProgressViewProvider } from './progressView/ProgressViewProvider';
import { FolderExplorer } from './FolderExplorer';
import { ExplorerOperations } from './explorer/ExplorerOperations';
import { ExplorerCommands } from './explorer/ExplorerCommands';
import { WatcherManager } from './explorer/WatcherManager';
import { registerCommands, getMainViewProvider } from './commands';

let statusBarItem: vscode.StatusBarItem | undefined;
let apiKeyStatusBarItem: vscode.StatusBarItem | undefined;
let disposeStatusListener: (() => void) | undefined;

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
    apiKeyStatusBarItem.command = 'texra.setApiKey';
    apiKeyStatusBarItem.show();
  } else {
    apiKeyStatusBarItem.hide();
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
  // Initialize server-side key access with SupabaseClient as auth provider
  initializeServerSideKeyAccess(context, {
    isAuthenticated: () => SupabaseClient.isAuthenticated(),
    getUserTier: () => SupabaseClient.getUserTier(),
    getAccessToken: () => SupabaseClient.getAccessToken(),
  });

  // Copy default agents BEFORE initializing the agent index
  // This ensures built-in agents are available when the index scans directories
  await copyDefaultAgents(context);

  // Refresh model list to defaults if version changed (adds new models for existing users)
  await refreshModelListIfNeeded();

  // Initialize agent index (single source of truth for agent metadata)
  const { loadAgents } = await import('@agent/index');

  // Start loading the agent index in the background
  // This will scan all directories and fetch remote agents
  loadAgents().catch((err) => {
    logger.error(
      'extension',
      `Failed to initialize agent index: ${toErrorMessage(err)}`,
    );
  });

  // Initialize Supabase authentication if enabled
  const authEnabled = getConfig<boolean>('auth.enabled', true);

  if (authEnabled) {
    try {
      const { SupabaseAuthProvider } =
        await import('@/auth/SupabaseAuthProvider');
      const { isSupabaseConfigured, setRuntimeExtensionId } =
        await import('@/auth/config');

      // Set the runtime extension ID for OAuth redirects
      // This ensures the redirect URI matches the actual extension ID
      setRuntimeExtensionId(context.extension.id);

      // Check if Supabase credentials are configured
      if (!isSupabaseConfigured()) {
        logger.warn(
          'extension',
          'Supabase authentication is enabled but credentials are not configured. Please configure credentials in src/auth/config.ts before building.',
        );
      } else {
        // Register authentication provider
        const authProvider = new SupabaseAuthProvider(context);
        context.subscriptions.push(
          vscode.authentication.registerAuthenticationProvider(
            'texra-supabase',
            'TeXRA Account',
            authProvider,
            { supportsMultipleAccounts: false },
          ),
        );

        // Register URI handler for OAuth callbacks
        const { SupabaseUriHandler } = await import('@/auth/UriHandler');
        const uriHandler = new SupabaseUriHandler();
        context.subscriptions.push(
          vscode.window.registerUriHandler(uriHandler),
        );

        // Connect URI handler to auth provider
        authProvider.setUriHandler(uriHandler);

        // Note: Auth state change listener is handled in MainViewProvider.setupAuthListener()
        // to avoid duplicate refresh calls when user logs in/out.

        // Initialize usage logging service for backend analytics (only when auth is available)
        const extensionVersion =
          typeof context.extension.packageJSON?.version === 'string'
            ? context.extension.packageJSON.version
            : undefined;
        UsageLogService.initialize({}, extensionVersion);
        // Add safety net disposable in case deactivate() isn't called
        context.subscriptions.push({
          dispose: () => void UsageLogService.dispose(),
        });

        logger.info('extension', 'Supabase authentication provider registered');
      }
    } catch (error) {
      logger.error(
        'extension',
        `Failed to initialize Supabase authentication: ${toErrorMessage(error)}`,
      );
    }
  }

  // Create the log view provider
  const progressViewProvider = new ProgressViewProvider(context);
  await progressViewProvider.initialize();

  // PersistedFlow handles state persistence automatically.
  // Waiting streams detection will be restored from ExecutionKVStore in future.
  const waitingStreams = new Set<string>();

  // Log activation message to ensure the logger is working correctly
  logger.info('extension', 'TeXRA extension activated');

  // Clean up any tasks that were left in "running" state from previous session
  await progressViewProvider.cleanupTasksAfterRestart(waitingStreams);

  // Configure LaTeX settings if LaTeX Workshop is installed
  configureLatexSettings();

  // Register commands first - this will create and store the MainViewProvider
  registerCommands(context);

  initializeToolEditApproval(context);

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
  void refreshApiKeyStatus().catch((err) =>
    logger.error(
      'extension',
      `API key status refresh failed: ${toErrorMessage(err)}`,
    ),
  );

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
    void vscode.commands.executeCommand('texra.openGettingStarted');
    void showInstructionWithSuppress(
      'welcome',
      'Welcome to TeXRA! The new "Run your first TeXRA workflow" walkthrough will guide you through seeding the sample project, configuring API keys, staging files, enabling automatic figure/TikZ extraction, and executing your first run.',
      [
        {
          title: 'Open Walkthrough',
          callback: async () => {
            await vscode.commands.executeCommand('texra.openGettingStarted');
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
      .catch((err) =>
        logger.error(
          'extension',
          `Welcome instruction failed: ${toErrorMessage(err)}`,
        ),
      );
  }
}

export async function deactivate() {
  disposeStatusListener?.();

  // Flush any pending usage logs before deactivating
  await UsageLogService.dispose();

  // PersistedFlow cleanup is handled automatically via ExecutionKVStore.

  // Notify all listeners that extension is deactivating
  bus.emit('extensionDeactivating', undefined);

  statusBarItem?.dispose();
  disposeDiffRefresh();
}
