/**
 * VS Code adapter for the platform-agnostic WorkspaceProvider.
 *
 * Uses vscode.workspace.workspaceFolders and asRelativePath.
 */
import * as vscode from 'vscode';

import type { WorkspaceProvider } from '@platform/interfaces';

export class VscodeWorkspace implements WorkspaceProvider {
  getWorkspacePath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  asRelativePath(filePath: string): string {
    return vscode.workspace.asRelativePath(filePath, false);
  }
}
