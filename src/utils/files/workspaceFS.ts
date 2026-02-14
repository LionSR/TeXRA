// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - filesystem
import { RelativeFS } from './relativeFS';
import { locatePathInRoot, type ResolvedPath } from './workspaceRoot';

/**
 * Static filesystem helper rooted at the VS Code workspace folder.
 *
 * Inherits file I/O from {@link RelativeFS}. Path resolution uses VS Code's
 * `asRelativePath` for symlink-aware handling of absolute paths, and
 * {@link locatePathInRoot} for relative paths.
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
   * Convert an absolute path to a workspace-relative path.
   * Uses VS Code's `asRelativePath` which properly handles symlinks.
   * Returns the original path if no workspace is open.
   *
   * Always returns forward slashes for cross-platform consistency.
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
    return path.isAbsolute(filePath) ? filePath : this.fullPath(filePath);
  }

  /**
   * Resolve a path (absolute or relative) against the workspace root.
   *
   * Returns a discriminated union — callers apply their own policy
   * (throw on external, create ExternalFileLocation, etc.).
   *
   * Absolute paths use VS Code's `asRelativePath` for symlink-aware
   * resolution. Relative paths use {@link locatePathInRoot} (pure `path`
   * logic). No-workspace case treats everything as external.
   */
  public static locatePath(inputPath: string): ResolvedPath {
    const workspaceRoot = this.getPath();

    // No workspace — everything is external
    if (!workspaceRoot) {
      if (!inputPath) {
        return { kind: 'external', absolutePath: '' };
      }
      return { kind: 'external', absolutePath: path.resolve(inputPath) };
    }

    // Empty input → workspace root itself
    if (!inputPath) {
      return {
        kind: 'workspace',
        absolutePath: workspaceRoot,
        relativePath: '',
      };
    }

    // Absolute paths: use VS Code's asRelativePath for symlink handling
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

    // Relative paths: pure path logic, no VS Code dependency
    return locatePathInRoot(workspaceRoot, inputPath);
  }
}
