/**
 * VS Code adapter for the platform-agnostic WorkspaceProvider.
 *
 * Uses vscode.workspace.workspaceFolders and asRelativePath.
 */
import * as vscode from 'vscode';

import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import type { WorkspaceProvider } from '@platform/interfaces';

export class VscodeWorkspace implements WorkspaceProvider {
  private readonly workspace = createNodeWorkspace(() =>
    this.rawWorkspacePath(),
  );

  private rawWorkspacePath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  getWorkspacePath(): string | undefined {
    return this.workspace.getWorkspacePath();
  }

  getLegacyWorkspacePaths(): readonly string[] {
    const rawPath = this.rawWorkspacePath();
    return rawPath && rawPath !== this.getWorkspacePath() ? [rawPath] : [];
  }

  asRelativePath(filePath: string): string {
    return this.workspace.asRelativePath(filePath);
  }
}
