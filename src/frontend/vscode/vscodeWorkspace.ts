/**
 * VS Code adapter for the platform-agnostic WorkspaceProvider.
 *
 * Uses vscode.workspace.workspaceFolders and asRelativePath.
 */
import * as vscode from 'vscode';

import type { WorkspaceProvider } from '@platform/interfaces/workspace';

export class VscodeWorkspace implements WorkspaceProvider {
  getWorkspacePath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  asRelativePath(filePath: string): string {
    return vscode.workspace.asRelativePath(filePath, false);
  }

  watch(globPattern: string, listener: () => void): vscode.Disposable {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const patterns = workspaceFolders?.length
      ? workspaceFolders.map(
          (folder) => new vscode.RelativePattern(folder, globPattern),
        )
      : [globPattern];
    const watchers = patterns.map((pattern) =>
      vscode.workspace.createFileSystemWatcher(pattern, false, false, false),
    );
    const subscriptions = watchers.flatMap((watcher) => [
      watcher.onDidCreate(listener),
      watcher.onDidChange(listener),
      watcher.onDidDelete(listener),
    ]);

    return new vscode.Disposable(() => {
      subscriptions.forEach((subscription) => subscription.dispose());
      watchers.forEach((watcher) => watcher.dispose());
    });
  }
}
