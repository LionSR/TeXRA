/**
 * Node.js workspace provider for CLI / Electron / tests.
 * Uses process.cwd() as the workspace root.
 */
import * as fs from 'fs';
import * as path from 'path';

import { minimatch } from 'minimatch';

import type { WorkspaceProvider } from '../interfaces/workspace';

function normalizeRelativePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function shouldNotify(
  globPattern: string,
  relativePath: string | null,
): boolean {
  if (relativePath == null) return true;
  return minimatch(normalizeRelativePath(relativePath), globPattern, {
    dot: true,
  });
}

function listDirectories(root: string): string[] {
  const directories = [root];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    directories.push(...listDirectories(path.join(root, entry.name)));
  }
  return directories;
}

function createRecursiveFallbackWatcher(
  root: string,
  globPattern: string,
  listener: () => void,
): { dispose(): void } {
  const watchers: fs.FSWatcher[] = [];
  const watchedDirectories = new Set<string>();

  const watchDirectory = (directory: string): void => {
    if (watchedDirectories.has(directory)) return;
    watchedDirectories.add(directory);

    const watcher = fs.watch(directory, (_event, filename) => {
      const absolutePath =
        filename == null ? null : path.join(directory, filename.toString());
      const relativePath =
        absolutePath == null ? null : path.relative(root, absolutePath);

      if (absolutePath && fs.existsSync(absolutePath)) {
        try {
          if (fs.statSync(absolutePath).isDirectory()) {
            for (const nested of listDirectories(absolutePath)) {
              watchDirectory(nested);
            }
          }
        } catch {
          // File may have been removed between existsSync and statSync.
        }
      }

      if (shouldNotify(globPattern, relativePath)) {
        listener();
      }
    });
    watchers.push(watcher);
  };

  for (const directory of listDirectories(root)) {
    watchDirectory(directory);
  }

  return {
    dispose: () => watchers.forEach((watcher) => watcher.close()),
  };
}

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
    return normalizeRelativePath(relative);
  },

  watch(globPattern: string, listener: () => void): { dispose(): void } {
    const root = this.getWorkspacePath();
    if (!root) {
      return { dispose: () => {} };
    }

    try {
      const watcher = fs.watch(
        root,
        { recursive: true },
        (_event, filename) => {
          const relativePath = filename?.toString() ?? null;
          if (shouldNotify(globPattern, relativePath)) {
            listener();
          }
        },
      );
      return {
        dispose: () => watcher.close(),
      };
    } catch {
      return createRecursiveFallbackWatcher(root, globPattern, listener);
    }
  },
};
