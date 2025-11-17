// Standard library imports
import * as path from 'path';

// Local imports
import type { OutputFileInfo, FileLocation } from './types';

/**
 * Get display label for a file.
 * Uses the source name (e.g., "main.tex" from XML) or falls back to basename.
 */
export function getDisplayLabel(info: OutputFileInfo): string {
  if (info.source) {
    return info.source;
  }
  if (
    info.location.kind === 'workspace' ||
    info.location.kind === 'runStorage'
  ) {
    return path.basename(info.location.relativePath);
  }
  return path.basename(info.location.absolutePath);
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

/**
 * Get the workspace-relative path for display/comparison.
 * Returns the most user-friendly relative path.
 */
export function getDisplayPath(location: FileLocation): string {
  if (location.kind === 'workspace' || location.kind === 'runStorage') {
    return location.relativePath;
  }
  return location.absolutePath;
}

/**
 * Get the absolute path from a location.
 * This is the canonical path for all file operations.
 */
export function getAbsolutePath(location: FileLocation): string {
  return location.absolutePath;
}

/**
 * Get the workspace absolute path if the file is in workspace.
 * Returns undefined if file is not in workspace.
 */
export function getWorkspacePath(location: FileLocation): string | undefined {
  return location.kind === 'workspace' ? location.absolutePath : undefined;
}

/**
 * Extract execution ID from a file location.
 * Returns undefined if the file is not in run storage.
 */
export function getExecutionId(location: FileLocation): string | undefined {
  return location.kind === 'runStorage' ? location.executionId : undefined;
}
