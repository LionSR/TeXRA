// Standard library imports
import * as path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  resolveExistingRunStoragePath,
  resolveRunOriginalSnapshotPath,
  resolveRunStoragePath,
  resolveRunStorageRelativePath,
  RUNS_STORAGE_DIR,
} from '@platform/defaults/workspaceStorage';
import { isFileNotFoundError } from '@common/errors';
import * as logger from '@logger/logUtils';
import { type ExecutionId, type RunStorageFileLocation } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { getPathSegments } from '@utils/core/pathCore';
import { createRunStorageLocation } from './fileLocation';
import { StorageFS } from './storageFS';

export const CHANNEL = 'taskRunStorage';

export function getRunDir(id: ExecutionId): string {
  return StorageFS.fullPath(resolveRunStoragePath(id));
}

export function getOriginalSnapshotPath(
  executionId: ExecutionId,
  workspaceRelativePath: string,
): string {
  return StorageFS.fullPath(
    resolveRunOriginalSnapshotPath(executionId, workspaceRelativePath),
  );
}

export async function findExistingRunStoragePath(
  ...segments: string[]
): Promise<string | undefined> {
  return resolveExistingRunStoragePath(
    segments,
    StorageFS.exists.bind(StorageFS),
  );
}

export async function findRunDir(id: ExecutionId): Promise<string | undefined> {
  const rel = await findExistingRunStoragePath(id);
  return rel ? StorageFS.fullPath(rel) : undefined;
}

export async function ensureRunDir(id: ExecutionId): Promise<void> {
  await StorageFS.ensureDir(RUNS_STORAGE_DIR);
  await StorageFS.ensureDir(resolveRunStoragePath(id));
}

export function getRunStorageAbsolutePath(
  id: ExecutionId,
  workspaceRelative: string,
): string {
  return StorageFS.fullPath(resolveRunStoragePath(id, workspaceRelative));
}

export function runStorageLocationFromAbsolutePath(
  absolutePath: string,
  executionId: ExecutionId,
): RunStorageFileLocation | undefined {
  if (!path.isAbsolute(absolutePath)) return undefined;
  const relativePath = resolveRunStorageRelativePath(
    absolutePath,
    getRunDir(executionId),
  );
  if (!relativePath) return undefined;
  return createRunStorageLocation(absolutePath, relativePath, executionId);
}

export async function ensureParentDir(filePath: string): Promise<void> {
  const parentDir = path.dirname(filePath);
  await fs.mkdir(parentDir, { recursive: true });
}

/** Non-ENOENT stat failures are re-thrown so a permissions error never silently forces a re-copy over a real snapshot. */
export async function snapshotExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.stat(absolutePath);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) return false;
    throw new Error(
      `Failed to inspect snapshot destination ${absolutePath}: ${toErrorMessage(error)}`,
      { cause: error },
    );
  }
}

export async function createSymlink(
  sourceAbsolute: string,
  destination: string,
): Promise<void> {
  await ensureParentDir(destination);
  try {
    await fs.symlink(sourceAbsolute, destination);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') {
      await fs.rm(destination, { recursive: true, force: true });
      await fs.symlink(sourceAbsolute, destination);
      return;
    }
    if (
      err.code &&
      ['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP'].includes(err.code)
    ) {
      logger.warn(
        CHANNEL,
        `Falling back to copy ${sourceAbsolute} -> ${destination} due to ${err.code}`,
      );
      const stats = await fs.lstat(sourceAbsolute);
      if (stats.isDirectory()) {
        await fs.cp(sourceAbsolute, destination, { recursive: true });
      } else {
        await fs.copyFile(sourceAbsolute, destination);
      }
      return;
    }
    throw err;
  }
}

/**
 * Workspace-relative directories that should never be moved into run storage.
 *
 * History folders contain prior execution data that is managed separately,
 * so keep them in place even when task-run isolation is enabled.
 */
const IGNORED_WORKSPACE_ROOTS = new Set(['History', 'history']);

export function shouldSkipRelocation(relativePath: string): boolean {
  const segments = getPathSegments(relativePath);
  return segments.length > 0 && IGNORED_WORKSPACE_ROOTS.has(segments[0]);
}
