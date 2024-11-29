import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { FolderExplorer } from './folderExplorer';

export function activate(context: vscode.ExtensionContext) {
  registerCommands(context);

  // Register the folder explorer with context
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  const folderExplorer = new FolderExplorer(workspaceRoot, context);
  
  // Register the tree data provider
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('coauthor.folderExplorer', folderExplorer),
    // Add watcher for configuration changes
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('coauthor.explorer.rootPath')) {
        folderExplorer.setupFileSystemWatcher();
        folderExplorer.refresh();
      }
    }),
    // Add disposable for cleanup
    { dispose: () => folderExplorer.dispose() }
  );
}

export function deactivate() {}
