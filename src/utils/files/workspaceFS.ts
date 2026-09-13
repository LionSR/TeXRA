// Node imports
import * as path from 'node:path';

// Local imports
import { workspaceRoots } from '@platform/workspaceRoots';
import { relativeToRoot } from '@platform/defaults/nodeWorkspace';
import { normalizeFilePath } from '@utils/core';

// Local file imports
import { RelativeFS } from './relativeFS';
import {
  annotateExternal,
  locatePathInRoot,
  type ResolvedPath,
} from './workspaceRoot';

/**
 * Static filesystem rooted at the current session's workspace folder.
 * File I/O from {@link RelativeFS}; path resolution via the session's
 * `WorkspaceRoots` + {@link locatePathInRoot}.
 */
export class WorkspaceFS extends RelativeFS {
  protected static override getBasePath(): string {
    const wsPath = workspaceRoots().workspace;
    if (!wsPath) {
      throw new Error('Workspace path is not available.');
    }
    return wsPath;
  }

  public static getPath(): string | undefined {
    return workspaceRoots().workspace;
  }

  /**
   * Workspace-relative path, symlink-aware. A path outside the workspace (or
   * with no workspace open) comes back as the caller's own path, normalized.
   */
  public static relativePath(filePath: string): string {
    return workspaceRelativePath(this.getPath(), filePath);
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
    return locateInWorkspace(this.getPath(), inputPath);
  }
}

/** {@link WorkspaceFS.relativePath} against an explicit workspace root. */
function workspaceRelativePath(
  root: string | undefined,
  filePath: string,
): string {
  if (!root) {
    return filePath;
  }
  return normalizeFilePath(relativeToRoot(root, filePath) ?? filePath);
}

/**
 * {@link WorkspaceFS.locatePath} against an explicit workspace root — the
 * form for code that holds a run's session roots as data rather than reading
 * the calling context's roots scope.
 */
export function locateInWorkspace(
  root: string | undefined,
  inputPath: string,
): ResolvedPath {
  if (!root) {
    if (!inputPath) return { kind: 'external', absolutePath: '' };
    return annotateExternal({
      kind: 'external',
      absolutePath: path.resolve(inputPath),
    });
  }

  // Absolute paths: platform's asRelativePath for symlink handling
  if (path.isAbsolute(inputPath)) {
    const relativePath = workspaceRelativePath(root, inputPath);
    if (!path.isAbsolute(relativePath) && !relativePath.startsWith('..')) {
      return { kind: 'workspace', absolutePath: inputPath, relativePath };
    }
    return annotateExternal({ kind: 'external', absolutePath: inputPath });
  }

  // Empty + relative paths: pure path logic
  return locatePathInRoot(root, inputPath);
}
