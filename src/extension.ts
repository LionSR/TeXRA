// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import dotenv from 'dotenv';

// Local imports - core
import * as logger from '@logger/logUtils';
import { watchConfig } from '@utils/config';
import { SecretManager } from '@frontend/secretManager';
import { copyDefaultAgents, configureLatexSettings } from '@frontend/setup';
import { disposeDiffRefresh } from '@frontend/ui/diffView';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { StorageFS } from '@utils/files';
import { TASK_RUNS_DIR } from '@utils/files/taskRunStorage';
import { initializeStateManagers } from '@common/state/stateManager';
import { FileLister } from '@frontend/files/fileLister';
import { bus } from '@eventBus/ProgressEventBus';

// Local imports - components
import { ProgressViewProvider } from './progressView/ProgressViewProvider';
import { FolderExplorer } from './FolderExplorer';
import { ExplorerOperations } from './explorer/ExplorerOperations';
import { ExplorerCommands } from './explorer/ExplorerCommands';
import { WatcherManager } from './explorer/WatcherManager';
import { registerCommands } from './commands';

let statusBarItem: vscode.StatusBarItem | undefined;
let disposeStatusListener: (() => void) | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    const openAction = 'Open Folder';
    vscode.window
      .showInformationMessage(
        'TeXRA requires an open workspace. Please open a folder to enable the extension.',
        openAction,
      )
      .then((choice) => {
        if (choice === openAction) {
          vscode.commands.executeCommand('workbench.action.files.openFolder');
        }
      });
    return; // Exit before further initialization
  } else if (workspaceFolders.length > 1) {
    const openAction = 'Open Folder';
    vscode.window
      .showInformationMessage(
        'TeXRA supports only a single-folder workspace. Please open one folder to enable the extension.',
        openAction,
      )
      .then((choice) => {
        if (choice === openAction) {
          vscode.commands.executeCommand('workbench.action.files.openFolder');
        }
      });
    return;
  }
  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  dotenv.config({
    path: path.join(workspaceRoot, '.env'),
  });

  // Initialize storage systems
  SecretManager.initialize(context);
  StorageFS.initialize(context);
  await StorageFS.ensureDir(TASK_RUNS_DIR);
  initializeStateManagers(context);
  FileLister.initialize(context);

  // Create the log view provider
  const progressViewProvider = new ProgressViewProvider(context);
  await progressViewProvider.initialize();

  // Log activation message to ensure the logger is working correctly
  logger.info('extension', 'TeXRA extension activated');

  // Clean up any tasks that were left in "running" state from previous session
  progressViewProvider.cleanupTasksAfterRestart();

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

  const runningStreams = new Set<string>();
  disposeStatusListener = bus.on(
    'updateStreamStatus',
    ({ stream, status }: { stream: string; status: string }) => {
      if (status === 'running') {
        runningStreams.add(stream);
      } else if (
        status === 'stopped' ||
        status === 'error' ||
        status === 'cancelled'
      ) {
        runningStreams.delete(stream);
      }
      statusBarItem!.text =
        runningStreams.size > 0 ? 'TeXRA: Running' : 'TeXRA: Idle';
    },
  );

  context.subscriptions.push({ dispose: disposeStatusListener }, statusBarItem);

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
  if (!context.globalState.get('texra.welcomeShown')) {
    setTimeout(() => {
      showInstructionWithSuppress(
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
      ).catch(console.error);
    }, 0);
    await context.globalState.update('texra.welcomeShown', true);
  }
}

export function deactivate() {
  disposeStatusListener?.();
  // Get the ProgressViewProvider instance
  const progressViewProvider = ProgressViewProvider.getInstance();
  if (progressViewProvider) {
    // Mark all running tasks as cancelled when extension deactivates
    progressViewProvider.eventHandler.markAllRunningTasksAsCancelled();
  }
  statusBarItem?.dispose();
  disposeDiffRefresh();
}
