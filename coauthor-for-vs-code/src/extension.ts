// Standard library imports
import * as fs from 'fs';
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - core
import * as logger from './logger/logUtils';

// Local imports - components
import { LogViewProvider } from './logger/LogViewProvider';
import { FolderExplorer } from './FolderExplorer';
import { registerCommands } from './commands';

async function copyDefaultAgents(context: vscode.ExtensionContext) {
  const resourcesPath = path.join(context.extensionPath, 'resources', 'agents');
  const globalStoragePath = path.join(
    context.globalStorageUri.fsPath,
    'agents',
  );

  try {
    // Ensure the global storage agents directory exists
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(globalStoragePath),
    );

    // Read all files from resources/agents
    const files = await fs.promises.readdir(resourcesPath);

    for (const file of files) {
      const sourcePath = path.join(resourcesPath, file);
      const targetPath = path.join(globalStoragePath, file);

      // Only copy if target doesn't exist
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(targetPath));
      } catch {
        // File doesn't exist, copy it
        const content = await fs.promises.readFile(sourcePath);
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(targetPath),
          content,
        );
      }
    }
  } catch (error) {
    console.error('Error copying default agents:', error);
  }
}

export function activate(context: vscode.ExtensionContext) {
  // Create and register the log view provider
  const logViewProvider = new LogViewProvider(context);
  logger.setLogViewProvider(logViewProvider);

  // Copy default agents
  copyDefaultAgents(context);

  // Register commands
  registerCommands(context);

  // Register the folder explorer with context
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  const folderExplorer = new FolderExplorer(workspaceRoot, context);

  // Register the tree data provider and log view provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'coauthor.logView',
      logViewProvider,
    ),
    vscode.window.registerTreeDataProvider(
      'coauthor.folderExplorer',
      folderExplorer,
    ),
    // Add watcher for configuration changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('coauthor.explorer.agentsDirectory')) {
        folderExplorer.setupFileSystemWatcher();
        folderExplorer.refresh();
      }
    }),
    // Add disposable for cleanup
    { dispose: () => folderExplorer.dispose() },
  );
}

export function deactivate() {}
