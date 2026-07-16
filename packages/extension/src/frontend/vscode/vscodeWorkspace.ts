/**
 * VS Code adapter for the platform-agnostic WorkspaceProvider.
 *
 * Uses vscode.workspace.workspaceFolders and asRelativePath.
 */
import * as vscode from 'vscode';

import { canonicalizeWorkspacePath } from '@platform/defaults/nodeWorkspace';
import type { WorkspaceProvider } from '@platform/interfaces';

export class VscodeWorkspace implements WorkspaceProvider {
  getWorkspacePath(): string | undefined {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return workspacePath ? canonicalizeWorkspacePath(workspacePath) : undefined;
  }

  asRelativePath(filePath: string): string {
    return vscode.workspace.asRelativePath(filePath, false);
  }
}
