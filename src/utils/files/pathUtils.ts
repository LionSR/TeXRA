// Standard library imports
import * as path from 'path';

// Local imports - utils
import type { FileLocation } from './taskRunStorage';
import { WorkspaceFS } from './workspaceFS';

/** Resolve a file path relative to the workspace if not already absolute. */
export function resolveFilePath(file: string): string {
  return path.isAbsolute(file) ? file : WorkspaceFS.fullPath(file);
}

/**
 * Get a display-friendly path for a file location.
 * For workspace/runStorage files, returns the relative path.
 * For external files, returns the full absolute path for clarity.
 *
 * Use this for logging and user-facing messages where the full path
 * of external files is helpful for identification.
 */
export function getDisplayPath(location: FileLocation): string {
  if (location.kind === 'workspace' || location.kind === 'runStorage') {
    return location.relativePath;
  }
  return location.absolutePath;
}
