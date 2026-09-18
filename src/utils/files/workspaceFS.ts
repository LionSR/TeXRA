// Node imports
import * as path from 'node:path';

// Local imports
import { workspaceRoots } from '@platform/workspaceRoots';
import { relativeToRoot } from '@platform/defaults/nodeWorkspace';
import { normalizeFilePath } from '@utils/core';
import { escapesRoot } from '@utils/core/pathCore';

// Local file imports
import {
  annotateExternal,
  locatePathInRoot,
  type ResolvedPath,
} from './workspaceRoot';

/**
 * The calling context's workspace folder, or `undefined` with none open.
 *
 * The one ambient read left in this module, for the callers that still
 * default their root instead of being handed one (#12421). Every path helper
 * below is a pure function of the root it is given.
 */
export function workspaceRootPath(): string | undefined {
  return workspaceRoots().workspace;
}

/**
 * The workspace-relative form of `filePath`, symlink-aware. A path outside
 * the workspace (or with no workspace open) comes back as the caller's own
 * path, normalized.
 */
export function workspaceRelativePath(
  root: string | undefined,
  filePath: string,
): string {
  if (!root) {
    return filePath;
  }
  return normalizeFilePath(relativeToRoot(root, filePath) ?? filePath);
}

/**
 * The absolute form of `filePath` against an explicit workspace root: a
 * relative path joins the root, and with no folder open it throws.
 */
export function workspaceAbsolutePath(
  root: string | undefined,
  filePath: string,
): string {
  if (path.isAbsolute(filePath)) return filePath;
  if (!root) {
    throw new Error('Workspace path is not available.');
  }
  return path.join(root, filePath);
}

/**
 * Resolve `inputPath` against an explicit workspace root, for code that holds
 * a run's session roots as data rather than reading the calling context's
 * roots scope. Returns 'workspace' or 'external' — callers apply their own
 * policy.
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
    if (!path.isAbsolute(relativePath) && !escapesRoot(relativePath)) {
      return { kind: 'workspace', absolutePath: inputPath, relativePath };
    }
    return annotateExternal({ kind: 'external', absolutePath: inputPath });
  }

  // Empty + relative paths: pure path logic
  return locatePathInRoot(root, inputPath);
}
