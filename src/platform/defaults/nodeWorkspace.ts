/**
 * Node.js workspace provider for CLI / Electron / tests.
 * Uses process.cwd() as the workspace root.
 */
import * as fs from 'fs';
import * as path from 'path';

import { minimatch } from 'minimatch';

import type { WorkspaceProvider } from '../interfaces/workspace';

const CASE_INSENSITIVE_GLOBS =
  process.platform === 'win32' || process.platform === 'darwin';
const IGNORED_WATCH_DIRECTORIES = new Set([
  '.cache',
  '.git',
  '.next',
  '.pnpm',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);

function normalizeRelativePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function shouldWatchDirectory(root: string, directory: string): boolean {
  const relativePath = normalizeRelativePath(path.relative(root, directory));
  if (!relativePath) return true;
  return !relativePath
    .split('/')
    .some((segment) => IGNORED_WATCH_DIRECTORIES.has(segment));
}

function shouldNotify(
  globPattern: string,
  relativePath: string | null,
): boolean {
  if (relativePath == null) return false;
  return minimatch(normalizeRelativePath(relativePath), globPattern, {
    dot: true,
    nocase: CASE_INSENSITIVE_GLOBS,
  });
}

function listDirectories(root: string): string[] {
  const directories = [root];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return directories;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (IGNORED_WATCH_DIRECTORIES.has(entry.name)) continue;
    directories.push(...listDirectories(path.join(root, entry.name)));
  }
  return directories;
}

function closeWatcher(watcher: fs.FSWatcher): void {
  try {
    watcher.close();
  } catch {
    // Watcher may already be closed by the OS after an async error.
  }
}

function createRecursiveFallbackWatcher(
  root: string,
  globPattern: string,
  listener: () => void,
): { dispose(): void } {
  let disposed = false;
  const watchers = new Set<fs.FSWatcher>();
  const watchedDirectories = new Set<string>();

  const watchDirectory = (directory: string): void => {
    if (disposed) return;
    if (watchedDirectories.has(directory)) return;
    watchedDirectories.add(directory);

    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(directory, (_event, filename) => {
        if (disposed) return;

        const absolutePath =
          filename == null ? null : path.join(directory, filename.toString());
        const relativePath =
          absolutePath == null ? null : path.relative(root, absolutePath);

        if (absolutePath && fs.existsSync(absolutePath)) {
          try {
            if (fs.statSync(absolutePath).isDirectory()) {
              if (!shouldWatchDirectory(root, absolutePath)) return;
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
    } catch {
      watchedDirectories.delete(directory);
      return;
    }

    watcher.on('error', () => {
      closeWatcher(watcher);
      watchers.delete(watcher);
      watchedDirectories.delete(directory);
    });

    watchers.add(watcher);
  };

  for (const directory of listDirectories(root)) {
    watchDirectory(directory);
  }

  return {
    dispose: () => {
      disposed = true;
      for (const watcher of watchers) {
        closeWatcher(watcher);
      }
      watchers.clear();
      watchedDirectories.clear();
    },
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
      let disposed = false;
      const watcher = fs.watch(
        root,
        { recursive: true },
        (_event, filename) => {
          if (disposed) return;

          const absolutePath =
            filename == null ? null : path.join(root, filename.toString());
          const relativePath =
            absolutePath == null ? null : path.relative(root, absolutePath);
          if (shouldNotify(globPattern, relativePath)) {
            listener();
          }
        },
      );
      watcher.on('error', () => closeWatcher(watcher));
      return {
        dispose: () => {
          disposed = true;
          closeWatcher(watcher);
        },
      };
    } catch {
      return createRecursiveFallbackWatcher(root, globPattern, listener);
    }
  },
};
