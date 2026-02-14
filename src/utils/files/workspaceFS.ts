// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - filesystem
import { RelativeFS } from './relativeFS';
import { WorkspaceRoot, type ResolvedPath } from './workspaceRoot';

export type { ResolvedPath };

/**
 * Static filesystem helper rooted at the VS Code workspace folder.
 *
 * Path resolution is delegated to {@link WorkspaceRoot} — a pure value object
 * that can also be instantiated independently (e.g. for git worktrees).
 * This class adds VS Code integration (reading workspaceFolders, using
 * `asRelativePath` for symlink-aware resolution) and inherits file I/O
 * from {@link RelativeFS}.
 *
 * For scoped file operations against an arbitrary root, use
 * {@link createScopedWorkspaceFS} instead.
 */
export class WorkspaceFS extends RelativeFS {
  protected static override getBasePath(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('Workspace path is not available.');
    }
    return folder.uri.fsPath;
  }

  public static getPath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /**
   * Get a {@link WorkspaceRoot} instance for the current VS Code workspace.
   * Returns `undefined` if no workspace folder is open.
   */
  public static getWorkspaceRoot(): WorkspaceRoot | undefined {
    const root = this.getPath();
    return root ? new WorkspaceRoot(root) : undefined;
  }

  /**
   * Convert an absolute path to a workspace-relative path.
   * Uses VS Code's asRelativePath which properly handles symlinks.
   * Returns the original path if no workspace is open.
   *
   * Always returns forward slashes for cross-platform consistency.
   * On Windows, vscode.workspace.asRelativePath() returns backslashes;
   * normalizing here ensures all downstream consumers get a consistent format.
   */
  public static relativePath(filePath: string): string {
    if (!this.getPath()) {
      return filePath;
    }
    return vscode.workspace
      .asRelativePath(filePath, false)
      .replaceAll('\\', '/');
  }

  /**
   * Convert a file path to an absolute path.
   * If already absolute, returns unchanged. Otherwise resolves relative to workspace.
   */
  public static toAbsolute(filePath: string): string {
    const wsRoot = this.getWorkspaceRoot();
    if (!wsRoot) {
      throw new Error('Workspace path is not available.');
    }
    return wsRoot.toAbsolute(filePath);
  }

  /**
   * Resolve a path (absolute or relative) against the workspace root.
   *
   * This is the single resolution primitive for workspace path handling.
   * Returns a discriminated union — callers apply their own policy
   * (throw on external, create ExternalFileLocation, etc.).
   *
   * Relative paths are normalized to forward slashes. Paths that escape
   * via `..` are treated as external.
   */
  public static locatePath(inputPath: string): ResolvedPath {
    const workspaceRoot = this.getPath();

    if (!workspaceRoot) {
      // No workspace — everything is external
      if (!inputPath) {
        return { kind: 'external', absolutePath: '' };
      }
      return { kind: 'external', absolutePath: path.resolve(inputPath) };
    }

    const wsRoot = new WorkspaceRoot(workspaceRoot);

    if (!inputPath) {
      return wsRoot.locatePath(inputPath);
    }

    if (path.isAbsolute(inputPath)) {
      // Use VS Code's asRelativePath for symlink handling on absolute paths
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

    // Relative paths delegate entirely to WorkspaceRoot
    return wsRoot.locatePath(inputPath);
  }
}
