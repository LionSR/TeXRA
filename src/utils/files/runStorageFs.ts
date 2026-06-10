// Standard library imports
import * as path from 'node:path';
import { promises as fs } from 'node:fs';

import { isFileNotFoundError, toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { type ExecutionId } from '@shared/schemas';
import { getPathSegments } from '@utils/core/pathCore';
import { StorageFS } from './storageFS';

export const CHANNEL = 'taskRunStorage';

/**
 * Directory for all per-execution artifacts (KV data, debug JSONs, logs, workflow outputs, etc.).
 * NOTE: This is 'executions', NOT 'taskRuns'. Name kept for import compatibility;
 * the legacy 'taskRuns' directory is LEGACY_RUNS_DIR below.
 */
export const TASK_RUNS_DIR = 'executions';

/** Legacy directory name — checked as read fallback for pre-consolidation data. */
export const LEGACY_RUNS_DIR = 'taskRuns';

/**
 * Get the full path to a specific execution's run directory.
 * @param id - The execution ID
 * @returns The full path to the run directory (always under TASK_RUNS_DIR)
 */
export function getRunDir(id: ExecutionId): string {
  return StorageFS.fullPath(path.join(TASK_RUNS_DIR, id));
}

/**
 * Absolute path of the immutable pre-run snapshot for a base file. The
 * snapshot is captured by {@link TaskRunFileService.prepareRunWorkspace}
 * before any agent modifications, so diffs against it remain accurate
 * even for in-place workflows where the live workspace file has since
 * been overwritten by the agent.
 *
 * Returns the candidate path unconditionally; callers should `stat` it
 * before reading because `prepareRunWorkspace` skips files that were
 * absent or non-regular at snapshot time.
 */
export function getOriginalSnapshotPath(
  executionId: ExecutionId,
  workspaceRelativePath: string,
): string {
  return StorageFS.fullPath(
    path.join(TASK_RUNS_DIR, executionId, 'original', workspaceRelativePath),
  );
}

/**
 * Resolve a storage-relative path, checking `executions/` first then
 * legacy `taskRuns/`. Returns the storage-relative path that exists,
 * or `undefined` if neither location has the target.
 */
export async function resolveStoragePath(
  ...segments: string[]
): Promise<string | undefined> {
  const primary = path.join(TASK_RUNS_DIR, ...segments);
  if (await StorageFS.exists(primary)) return primary;
  const legacy = path.join(LEGACY_RUNS_DIR, ...segments);
  if (await StorageFS.exists(legacy)) return legacy;
  return undefined;
}

/**
 * Resolve the full filesystem path for an execution's run directory,
 * checking `executions/` first then legacy `taskRuns/`.
 * Returns `undefined` if neither location exists.
 */
export async function resolveRunDir(
  id: ExecutionId,
): Promise<string | undefined> {
  const rel = await resolveStoragePath(id);
  return rel ? StorageFS.fullPath(rel) : undefined;
}

/**
 * Ensure an execution's run directory exists, creating it if necessary.
 * Also ensures the parent executions directory exists.
 * @param id - The execution ID
 */
export async function ensureRunDir(id: ExecutionId): Promise<void> {
  await StorageFS.ensureDir(TASK_RUNS_DIR);
  await StorageFS.ensureDir(path.join(TASK_RUNS_DIR, id));
}

/**
 * @internal Used internally by TaskRunFileService
 */
export function getRunStorageAbsolutePath(
  id: ExecutionId,
  workspaceRelative: string,
): string {
  return StorageFS.fullPath(path.join(TASK_RUNS_DIR, id, workspaceRelative));
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
