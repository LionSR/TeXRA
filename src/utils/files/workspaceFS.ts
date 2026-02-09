// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - filesystem
import { RelativeFS } from './relativeFS';

/**
 * Result of resolving a path against the workspace.
 * 'workspace' paths have both absolute and forward-slash relative forms.
 * 'external' paths are outside the workspace (or no workspace is open).
 */
export type ResolvedPath =
  | { kind: 'workspace'; absolutePath: string; relativePath: string }
  | { kind: 'external'; absolutePath: string };

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
    return path.isAbsolute(filePath) ? filePath : this.fullPath(filePath);
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

    if (!inputPath) {
      if (!workspaceRoot) {
        return { kind: 'external', absolutePath: '' };
      }
      return {
        kind: 'workspace',
        absolutePath: workspaceRoot,
        relativePath: '',
      };
    }

    if (path.isAbsolute(inputPath)) {
      if (!workspaceRoot) {
        return { kind: 'external', absolutePath: inputPath };
      }
      const relative = this.relativePath(inputPath);
      // relativePath() returns forward-slash normalized paths.
      // Outside-workspace paths remain absolute — detect with path.isAbsolute().
      if (!path.isAbsolute(relative) && !relative.startsWith('..')) {
        return {
          kind: 'workspace',
          absolutePath: inputPath,
          relativePath: relative,
        };
      }
      return { kind: 'external', absolutePath: inputPath };
    }

    // Relative path — convert backslashes to forward slashes BEFORE normalizing
    // so that path.posix.normalize() can properly collapse '..' segments.
    // On POSIX, backslashes are valid filename characters, so path.normalize()
    // would preserve them; the subsequent replaceAll would then create new
    // path separators that could form '..' traversals bypassing the check below.
    if (!workspaceRoot) {
      return { kind: 'external', absolutePath: path.resolve(inputPath) };
    }
    const relative = path.posix.normalize(inputPath.replaceAll('\\', '/'));
    if (relative.startsWith('..')) {
      return {
        kind: 'external',
        absolutePath: path.resolve(workspaceRoot, inputPath),
      };
    }
    return {
      kind: 'workspace',
      absolutePath: path.join(workspaceRoot, relative),
      relativePath: relative,
    };
  }
}
