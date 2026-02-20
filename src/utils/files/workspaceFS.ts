import * as path from 'path';
import * as vscode from 'vscode';
import { RelativeFS } from './relativeFS';
import { locatePathInRoot, type ResolvedPath } from './workspaceRoot';
import { workspaceRootStorage } from './workspaceRootContext';

/**
 * Static filesystem rooted at the VS Code workspace folder.
 * File I/O from {@link RelativeFS}; path resolution via VS Code + {@link locatePathInRoot}.
 *
 * When a workspace root override is active (e.g., during tool execution in a
 * git worktree), all operations transparently target the override path instead.
 */
export class WorkspaceFS extends RelativeFS {
  protected static override getBasePath(): string {
    const override = workspaceRootStorage.getStore();
    if (override) return override;

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('Workspace path is not available.');
    }
    return folder.uri.fsPath;
  }

  public static getPath(): string | undefined {
    const override = workspaceRootStorage.getStore();
    if (override) return override;
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /**
   * Workspace-relative path.
   * When a root override is active, uses path.relative() since VS Code's
   * asRelativePath only knows about workspace folders, not worktrees.
   */
  public static relativePath(filePath: string): string {
    const override = workspaceRootStorage.getStore();
    if (override) {
      const rel = path.relative(override, filePath).replaceAll('\\', '/');
      // On Windows, cross-drive paths remain absolute after path.relative()
      return rel.startsWith('..') || path.isAbsolute(rel) ? filePath : rel;
    }

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return filePath;

    return vscode.workspace
      .asRelativePath(filePath, false)
      .replaceAll('\\', '/');
  }

  /** Absolute path from relative. Already-absolute paths pass through. */
  public static toAbsolute(filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : this.fullPath(filePath);
  }

  /**
   * Resolve a path against the workspace root.
   * Returns 'workspace' or 'external' — callers apply their own policy.
   */
  public static locatePath(inputPath: string): ResolvedPath {
    const root = this.getPath();

    if (!root) {
      if (!inputPath) return { kind: 'external', absolutePath: '' };
      return { kind: 'external', absolutePath: path.resolve(inputPath) };
    }

    // Absolute paths: VS Code's asRelativePath for symlink handling
    if (path.isAbsolute(inputPath)) {
      const relative = this.relativePath(inputPath);
      if (!path.isAbsolute(relative) && !relative.startsWith('..')) {
        return {
          kind: 'workspace',
          absolutePath: inputPath,
          relativePath: relative,
        };
      }
      return { kind: 'external', absolutePath: inputPath };
    }

    // Empty + relative paths: pure path logic
    return locatePathInRoot(root, inputPath);
  }
}
