// Standard library imports
import * as path from 'path';

// Local imports - utils
import { WorkspaceFS } from './workspaceFS';

/** Resolve a file path relative to the workspace if not already absolute. */
export function resolveFilePath(file: string): string {
  return path.isAbsolute(file) ? file : WorkspaceFS.fullPath(file);
}

/** Determine if the given file has a TeX extension. */
export function isTexFile(file: string): boolean {
  return file.toLowerCase().endsWith('.tex');
}
