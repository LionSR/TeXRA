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

/**
 * Extract the base name (filename) from a file path.
 * Handles platform-specific separators (\ on Windows, / on Unix).
 *
 * @param filePath - Path to evaluate (can be absolute or relative)
 * @returns Base name of the file/directory
 * @example
 * getBasename('/home/user/document.pdf') // returns 'document.pdf'
 * getBasename('C:\\Users\\file.txt')     // returns 'file.txt'
 * getBasename('/path/to/')               // returns 'to'
 * getBasename('/')                       // returns ''
 */
export function getBasename(filePath: string): string {
  return path.basename(filePath);
}
