// Standard library imports
import * as path from 'path';

// Local imports
import type { FileLocation } from '@utils/files';
import type { OutputFileInfo } from './types';

/**
 * Get display label for a file.
 * Uses the source name (e.g., "main.tex" from XML) or falls back to basename.
 */
export function getDisplayLabel(info: OutputFileInfo): string {
  if (info.source) {
    return info.source;
  }
  return getFileBasename(info.location);
}

/**
 * Get basename from a FileLocation, handling all location types.
 * Safe helper that works with workspace, runStorage, and external locations.
 */
export function getFileBasename(location: FileLocation): string {
  if (location.kind === 'workspace' || location.kind === 'runStorage') {
    return path.basename(location.relativePath);
  }
  return path.basename(location.absolutePath);
}

/**
 * Get directory path from a FileLocation, handling all location types.
 * Returns the directory portion without the filename.
 */
export function getFileDirectory(location: FileLocation): string {
  if (location.kind === 'workspace' || location.kind === 'runStorage') {
    return path.dirname(location.relativePath);
  }
  return path.dirname(location.absolutePath);
}

/**
 * Get display directory for a file.
 * Returns the directory portion of the relative path, or empty string for root.
 */
export function getDisplayDir(info: OutputFileInfo): string {
  if (
    info.location.kind === 'workspace' ||
    info.location.kind === 'runStorage'
  ) {
    const dir = path.dirname(info.location.relativePath);
    return !dir || dir === '.' ? '' : dir;
  }
  return '';
}

// Note: getDisplayPath, getAbsolutePath, getWorkspacePath, and getExecutionId
// were removed as dead code. Use @utils/files/getDisplayPath for display paths.
