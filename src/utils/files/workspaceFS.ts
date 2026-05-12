import * as path from 'path';

// Platform imports
import { getWorkspaceProvider } from '@agent/core/workspace';

// Local imports - filesystem
import { RelativeFS } from './relativeFS';
import {
  annotateExternal,
  locatePathInRoot,
  type ResolvedPath,
} from './workspaceRoot';

/**
 * Static filesystem rooted at the workspace folder.
 * File I/O from {@link RelativeFS}; path resolution via WorkspaceProvider + {@link locatePathInRoot}.
 */
export class WorkspaceFS extends RelativeFS {
  protected static override getBasePath(): string {
    const wsPath = getWorkspaceProvider().getWorkspacePath();
    if (!wsPath) {
      throw new Error('Workspace path is not available.');
    }
    return wsPath;
  }

  public static getPath(): string | undefined {
    return getWorkspaceProvider().getWorkspacePath();
  }

  /** Workspace-relative path via the platform's symlink-aware asRelativePath. */
  public static relativePath(filePath: string): string {
    if (!this.getPath()) {
      return filePath;
    }
    return getWorkspaceProvider()
      .asRelativePath(filePath)
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
      return annotateExternal({
        kind: 'external',
        absolutePath: path.resolve(inputPath),
      });
    }

    // Absolute paths: platform's asRelativePath for symlink handling
    if (path.isAbsolute(inputPath)) {
      const relative = this.relativePath(inputPath);
      if (!path.isAbsolute(relative) && !relative.startsWith('..')) {
        return {
          kind: 'workspace',
          absolutePath: inputPath,
          relativePath: relative,
        };
      }
      return annotateExternal({ kind: 'external', absolutePath: inputPath });
    }

    // Empty + relative paths: pure path logic
    return locatePathInRoot(root, inputPath);
  }
}
