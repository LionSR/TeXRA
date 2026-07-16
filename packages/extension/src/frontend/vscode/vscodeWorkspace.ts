/**
 * VS Code adapter for the platform-agnostic WorkspaceProvider.
 *
 * Uses vscode.workspace.workspaceFolders and asRelativePath.
 */
import * as vscode from 'vscode';

import { canonicalizeWorkspacePath } from '@platform/defaults/nodeWorkspace';
import type { WorkspaceProvider } from '@platform/interfaces';

export class VscodeWorkspace implements WorkspaceProvider {
  private rawWorkspacePath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  getWorkspacePath(): string | undefined {
    const workspacePath = this.rawWorkspacePath();
    return workspacePath ? canonicalizeWorkspacePath(workspacePath) : undefined;
  }

  getLegacyWorkspacePaths(): readonly string[] {
    const rawPath = this.rawWorkspacePath();
    return rawPath && rawPath !== this.getWorkspacePath() ? [rawPath] : [];
  }

  asRelativePath(filePath: string): string {
    return vscode.workspace.asRelativePath(filePath, false);
  }
}
