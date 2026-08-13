// Standard library imports
import * as path from 'node:path';

import {
  type ExecutionId,
  type ExternalFileLocation,
  type FileLocation,
  type RunStorageFileLocation,
  type WorkspaceFileLocation,
} from '@shared/schemas';
import { WorkspaceFS } from './workspaceFS';

export function createWorkspaceLocation(
  absolutePath: string,
  relativePath: string,
): WorkspaceFileLocation {
  return {
    kind: 'workspace',
    absolutePath,
    relativePath,
  };
}

export function createRunStorageLocation(
  absolutePath: string,
  relativePath: string,
  executionId: ExecutionId,
): RunStorageFileLocation {
  return {
    kind: 'runStorage',
    absolutePath,
    relativePath,
    executionId,
  };
}

export function createExternalLocation(
  absolutePath: string,
): ExternalFileLocation {
  return {
    kind: 'external',
    absolutePath,
  };
}

/**
 * Get a comparable path for file matching and mapping.
 * Returns relativePath for workspace/runStorage files, absolutePath for external files.
 */
export function getComparablePath(location: FileLocation): string {
  return location.kind === 'external'
    ? location.absolutePath
    : location.relativePath;
}

/**
 * Get directory path from a FileLocation.
 * Returns relativePath's directory for workspace/runStorage, absolutePath's for external.
 */
export function getFileDirectory(location: FileLocation): string {
  return path.dirname(getComparablePath(location));
}

/**
 * Convert a string path to a FileLocation (standalone version).
 * Use this for utilities that don't have access to TaskRunFileService.
 * This function is NOT run-storage aware - it can only create workspace or external locations.
 * For run-storage awareness, use TaskRunFileService.createLocation() instead.
 *
 * Path normalization is handled internally - you can pass paths with either
 * forward slashes or backslashes. It's safe to pass already-normalized paths
 * (path.normalize() is idempotent).
 *
 * @param target - Absolute or workspace-relative path
 * @returns FileLocation (workspace or external, never runStorage)
 */
export function pathToLocation(target: string): FileLocation {
  const resolved = WorkspaceFS.locatePath(target);

  if (resolved.kind === 'external') {
    if (!target) {
      throw new Error('Cannot resolve empty path without workspace');
    }
    return createExternalLocation(resolved.absolutePath);
  }

  return createWorkspaceLocation(resolved.absolutePath, resolved.relativePath);
}

/**
 * Get a short display-friendly path for a file location.
 * For workspace files, returns the relative path (e.g., "logos/mpq-logo.pdf").
 * For external files, returns just the basename (not the full absolute path).
 *
 * This provides a concise human-readable path suitable for showing to users or models,
 * while absolutePath should be used for actual file operations.
 */
export function getShortDisplayPath(location: FileLocation): string {
  if (location.kind === 'workspace' || location.kind === 'runStorage') {
    return location.relativePath;
  }
  return path.basename(location.absolutePath);
}
