// Standard library imports
import * as fs from 'fs';
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - core
import * as logger from './logger/logUtils';
import { initializeSecrets } from './utils/secretUtils';
import { copyDefaultAgents, configureLatexSettings } from './utils/setupUtils';

// Local imports - components
import { ProgressViewProvider } from './progressView/ProgressViewProvider';
import { FolderExplorer } from './FolderExplorer';
import { registerCommands } from './commands';

export function activate(context: vscode.ExtensionContext) {
  // Initialize secrets storage
  initializeSecrets(context);

  // Create the log view provider
  const progressViewProvider = new ProgressViewProvider(context);

  // IMPORTANT: Register ProgressViewProvider with logger FIRST, before any other operations
  // This ensures all logs generated during activation go to the ProgressView
  logger.setProgressViewProvider(progressViewProvider);

  // Log activation message to ensure the logger is working correctly
  logger.info('extension', 'TeXRA extension activated');

  // Clean up any tasks that were left in "running" state from previous session
  progressViewProvider.cleanupTasksAfterRestart();

  // Copy default agents
  copyDefaultAgents(context);
  
  // Configure LaTeX settings if LaTeX Workshop is installed
  configureLatexSettings();

  // Register commands first - this will create and store the TeXRAViewProvider
  const registeredCommands = registerCommands(context);

  // Register the folder explorer with context
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  const folderExplorer = new FolderExplorer(workspaceRoot, context);

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
    // Add watcher for configuration changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('texra.explorer.agentsDirectory')) {
        folderExplorer.setupFileSystemWatcher();
        folderExplorer.refresh();
      }
    }),
    // Add disposable for cleanup
    { dispose: () => folderExplorer.dispose() },
  );
}

export function deactivate() {
  // Get the ProgressViewProvider instance
  const progressViewProvider = ProgressViewProvider.getInstance();
  if (progressViewProvider) {
    // Mark all running tasks as cancelled when extension deactivates
    progressViewProvider.markAllRunningTasksAsCancelled();
  }
}
