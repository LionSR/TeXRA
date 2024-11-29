import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { FolderExplorer } from './folderExplorer';

export function activate(context: vscode.ExtensionContext) {
  registerCommands(context);

  // Register the folder explorer
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  const folderExplorer = new FolderExplorer(workspaceRoot);
  
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('coauthor.folderExplorer', folderExplorer)
  );
}

export function deactivate() {}
