// Node imports
import * as path from 'node:path';

// Local imports
import { platform } from '@platform/platform';
import { normalizeFilePath } from '@utils/core';

// Local file imports
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
    const wsPath = platform().workspace.getWorkspacePath();
    if (!wsPath) {
      throw new Error('Workspace path is not available.');
    }
    return wsPath;
  }

  public static getPath(): string | undefined {
    return platform().workspace.getWorkspacePath();
  }

  /** Workspace-relative path via the platform's symlink-aware asRelativePath. */
  public static relativePath(filePath: string): string {
    if (!this.getPath()) {
      return filePath;
    }
    return normalizeFilePath(platform().workspace.asRelativePath(filePath));
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
      const relativePath = this.relativePath(inputPath);
      if (!path.isAbsolute(relativePath) && !relativePath.startsWith('..')) {
        return { kind: 'workspace', absolutePath: inputPath, relativePath };
      }
      return annotateExternal({ kind: 'external', absolutePath: inputPath });
    }

    // Empty + relative paths: pure path logic
    return locatePathInRoot(root, inputPath);
  }
}
