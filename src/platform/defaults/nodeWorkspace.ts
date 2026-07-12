/**
 * Node.js workspace provider for CLI / Electron / tests.
 * Uses process.cwd() as the workspace root.
 */
import * as path from 'node:path';

import { normalizeFilePath } from '@utils/core';
import { isPathWithin } from '@utils/core/pathCore';

import type { WorkspaceProvider } from '../interfaces';

export function createNodeWorkspace(
  getRoot: () => string | undefined = () => process.cwd(),
): WorkspaceProvider {
  return {
    getWorkspacePath(): string | undefined {
      return getRoot();
    },

    asRelativePath(filePath: string): string {
      const root = this.getWorkspacePath();
      if (!root) return filePath;
      const relative = path.relative(root, filePath);
      if (!isPathWithin(root, filePath)) {
        return filePath;
      }
      return normalizeFilePath(relative);
    },
  };
}
