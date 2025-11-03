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
import { ToolUseSnapshotStore } from '@agent/toolUse/ToolUseSnapshotStore';
import { ToolUseSessionManager } from '@agent/toolUse/ToolUseSessionManager';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { initializeToolEditApproval } from '@tools/approval/toolEditApproval';

// Local imports - components
import { ProgressViewProvider } from './progressView/ProgressViewProvider';
import { FolderExplorer } from './FolderExplorer';
import { ExplorerOperations } from './explorer/ExplorerOperations';
import { ExplorerCommands } from './explorer/ExplorerCommands';
import { WatcherManager } from './explorer/WatcherManager';
import { registerCommands } from './commands';

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

  // Create the log view provider
  const progressViewProvider = new ProgressViewProvider(context);
  await progressViewProvider.initialize();

  await ToolUseSnapshotStore.initialize();

  const toolUsePersistenceEnabled =
    ToolUseSessionManager.isPersistenceEnabled();
  const persistedToolUseSessions = toolUsePersistenceEnabled
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
  refreshApiKeyStatus().catch(console.error);

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
