/**
 * Node.js workspace provider for CLI / Electron / tests.
 * Uses process.cwd() as the workspace root.
 */
import { realpathSync } from 'node:fs';
import * as path from 'node:path';

import { normalizeFilePath } from '@utils/core';
import { isPathWithin } from '@utils/core/pathCore';

import type { WorkspaceProvider } from '../interfaces';

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
  return /^[a-z]:[\\/]/.test(canonical)
    ? `${canonical.charAt(0).toUpperCase()}${canonical.slice(1)}`
    : canonical;
}

export function createNodeWorkspace(
  getRoot: () => string | undefined = () => process.cwd(),
  getLegacyRoots?: () => readonly string[],
): WorkspaceProvider {
  return {
    getWorkspacePath(): string | undefined {
      const root = getRoot();
      return root ? canonicalizeWorkspacePath(root) : undefined;
    },

    ...(getLegacyRoots && { getLegacyWorkspacePaths: getLegacyRoots }),

    asRelativePath(filePath: string): string {
      const rawRoot = getRoot();
      if (!rawRoot) return filePath;
      const resolvedRoot = path.resolve(rawRoot);
      const resolvedFilePath = path.resolve(filePath);
      if (isPathWithin(resolvedRoot, resolvedFilePath)) {
        return normalizeFilePath(path.relative(resolvedRoot, resolvedFilePath));
      }

      const root = canonicalizeWorkspacePath(rawRoot);
      const canonicalFilePath = canonicalizeWorkspacePath(filePath);
      const relative = path.relative(root, canonicalFilePath);
      if (!isPathWithin(root, canonicalFilePath)) {
        return filePath;
      }
      return normalizeFilePath(relative);
    },
  };
}
