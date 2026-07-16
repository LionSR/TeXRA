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
  let canonical = path.resolve(workspacePath);
  try {
    canonical = realpathSync(canonical);
  } catch {
    // Preserve the resolved path when the filesystem cannot canonicalize it.
  }
  return /^[a-z]:[\\/]/.test(canonical)
    ? `${canonical.charAt(0).toUpperCase()}${canonical.slice(1)}`
    : canonical;
}

export function createNodeWorkspace(
  getRoot: () => string | undefined = () => process.cwd(),
): WorkspaceProvider {
  return {
    getWorkspacePath(): string | undefined {
      const root = getRoot();
      return root ? canonicalizeWorkspacePath(root) : undefined;
    },

    asRelativePath(filePath: string): string {
      const root = this.getWorkspacePath();
      if (!root) return filePath;
      const canonicalFilePath = canonicalizeWorkspacePath(filePath);
      const relative = path.relative(root, canonicalFilePath);
      if (!isPathWithin(root, canonicalFilePath)) {
        return filePath;
      }
      return normalizeFilePath(relative);
    },
  };
}
