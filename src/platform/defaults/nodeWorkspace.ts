/**
 * Workspace identity helpers shared by every Node host: one canonical
 * physical root per workspace, and symlink-aware workspace-relative paths.
 */
import { realpathSync } from 'node:fs';
import * as path from 'node:path';

import { normalizeFilePath } from '@utils/core';
import { isPathWithin } from '@utils/core/pathCore';
import { capitalize } from '@utils/text/stringUtils';

/**
 * Resolve one physical workspace identity for storage and host adapters.
 * Missing or temporarily inaccessible paths retain their resolved spelling.
 */
export function canonicalizeWorkspacePath(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  let existingAncestor = resolved;
  const missingSegments: string[] = [];
  let canonical = resolved;
  while (true) {
    try {
      canonical = path.join(realpathSync(existingAncestor), ...missingSegments);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = path.dirname(existingAncestor);
      if (
        (code !== 'ENOENT' && code !== 'ENOTDIR') ||
        parent === existingAncestor
      ) {
        break;
      }
      missingSegments.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
  return /^[a-z]:[\\/]/.test(canonical) ? capitalize(canonical) : canonical;
}

/**
 * Symlink-aware workspace-relative path: a fast `resolve`-then-compare pass,
 * then a canonicalize-then-compare fallback for paths that resolve through a
 * symlink (e.g. a symlinked folder inside the workspace). Shared by
 * `WorkspaceFS.relativePath` and the desktop native-picker path so the two
 * stay in sync. Returns `undefined` when `filePath` resolves outside `root`;
 * the caller owns its outside-root fallback (identity vs normalized absolute).
 */
export function relativeToRoot(
  root: string,
  filePath: string,
): string | undefined {
  const resolvedRoot = path.resolve(root);
  const resolvedFilePath = path.resolve(filePath);
  if (isPathWithin(resolvedRoot, resolvedFilePath)) {
    return normalizeFilePath(path.relative(resolvedRoot, resolvedFilePath));
  }
  const canonicalRoot = canonicalizeWorkspacePath(root);
  const canonicalFilePath = canonicalizeWorkspacePath(filePath);
  return isPathWithin(canonicalRoot, canonicalFilePath)
    ? normalizeFilePath(path.relative(canonicalRoot, canonicalFilePath))
    : undefined;
}
