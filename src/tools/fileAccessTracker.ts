// Standard library imports
import * as path from 'path';

// Local imports - tools
import { ToolError } from '@tools/result';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

const readFiles = new Set<string>();

function normalizePath(targetPath: string): string {
  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    return path.normalize(targetPath);
  }

  if (path.isAbsolute(targetPath)) {
    return path.normalize(targetPath);
  }

  return path.normalize(path.resolve(workspacePath, targetPath));
}

export function markFileAsRead(targetPath: string): void {
  readFiles.add(normalizePath(targetPath));
}

export function hasReadFile(targetPath: string): boolean {
  return readFiles.has(normalizePath(targetPath));
}

export function ensureFileWasRead(targetPath: string): void {
  if (!hasReadFile(targetPath)) {
    throw new ToolError(
      'Before editing, call the read_file tool on this path to confirm its current contents.',
    );
  }
}

export function clearTrackedFile(targetPath: string): void {
  readFiles.delete(normalizePath(targetPath));
}

export function resetTrackedFiles(): void {
  readFiles.clear();
}
