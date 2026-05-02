/**
 * Node.js workspace provider for CLI / Electron / tests.
 * Uses process.cwd() as the workspace root.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { WorkspaceProvider } from '../interfaces/workspace';

export const nodeWorkspace: WorkspaceProvider = {
  getWorkspacePath(): string | undefined {
    return process.cwd();
  },

  asRelativePath(filePath: string): string {
    const root = this.getWorkspacePath();
    if (!root) return filePath;
    const relative = path.relative(root, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return filePath;
    }
    return relative.replaceAll('\\', '/');
  },

  watch(_globPattern: string, listener: () => void): { dispose(): void } {
    const root = this.getWorkspacePath();
    if (!root) {
      return { dispose: () => {} };
    }

    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(root, { recursive: true }, listener);
    } catch {
      watcher = fs.watch(root, listener);
    }

    return {
      dispose: () => watcher.close(),
    };
  },
};
