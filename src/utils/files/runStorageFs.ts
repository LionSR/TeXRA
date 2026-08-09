// Node imports
import * as path from 'node:path';
import { promises as fs } from 'node:fs';

// Local imports
import { isFileNotFoundError } from '@common/errors';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import * as logger from '@logger/logUtils';
import {
  resolveRunOriginalSnapshotPath,
  resolveRunStoragePath,
  resolveRunStorageRelativePath,
  RUNS_STORAGE_DIR,
} from '@platform/defaults/workspaceStorage';
import {
  ExecutionIdSchema,
  type ExecutionId,
  type RunStorageFileLocation,
} from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { getPathSegments } from '@utils/core/pathCore';

// Local file imports
import { createRunStorageLocation } from './fileLocation';
import { isDirectory, isFile, isSymlink } from './fsEntryType';
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

export function findExistingRunStoragePath(
  ...segments: string[]
): Promise<string | undefined> {
  const storagePath = resolveRunStoragePath(...segments);
  return StorageFS.exists(storagePath).then((exists) =>
    exists ? storagePath : undefined,
  );
}

export async function findRunDir(id: ExecutionId): Promise<string | undefined> {
  const rel = await findExistingRunStoragePath(id);
  return rel ? StorageFS.fullPath(rel) : undefined;
}

export type RunStorageEntryInspection =
  | { readonly kind: 'file'; readonly location: RunStorageFileLocation }
  | {
      readonly kind: 'symlink' | 'directory' | 'unsupported';
      readonly absolutePath: string;
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly reason: string };

async function storageEntryType(target: string): Promise<number | undefined> {
  try {
    return (await StorageFS.stat(target)).type;
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  }
}

/**
 * Inspect one execution-relative run-storage entry without following a
 * workspace-mirror symlink.
 */
export async function inspectRunStorageEntry(
  executionId: ExecutionId,
  relativePath: string,
): Promise<RunStorageEntryInspection> {
  const posixPath = relativePath.replaceAll('\\', '/');
  const pathSegments = getPathSegments(posixPath);
  if (
    pathSegments.length === 0 ||
    path.posix.isAbsolute(posixPath) ||
    path.win32.isAbsolute(relativePath) ||
    pathSegments.includes('..')
  ) {
    return {
      kind: 'invalid',
      reason:
        'Run-storage paths must be non-empty relative paths without parent traversal.',
    };
  }
  const normalizedPath = path.posix.normalize(posixPath);

  const root = resolveRunStoragePath(executionId);
  const entry = resolveRunStoragePath(executionId, normalizedPath);
  const ancestors = [root];
  for (const [index] of pathSegments.slice(0, -1).entries()) {
    ancestors.push(
      resolveRunStoragePath(executionId, ...pathSegments.slice(0, index + 1)),
    );
  }
  for (const ancestor of ancestors) {
    const ancestorType = await storageEntryType(ancestor);
    if (ancestorType === undefined) return { kind: 'missing' };
    if (isSymlink(ancestorType)) {
      return {
        kind: 'symlink',
        absolutePath: StorageFS.fullPath(ancestor),
      };
    }
    if (!isDirectory(ancestorType)) {
      return {
        kind: 'unsupported',
        absolutePath: StorageFS.fullPath(ancestor),
      };
    }
  }

  const type = await storageEntryType(entry);
  if (type === undefined) return { kind: 'missing' };
  const absolutePath = StorageFS.fullPath(entry);
  if (isSymlink(type)) return { kind: 'symlink', absolutePath };
  if (isFile(type)) {
    return {
      kind: 'file',
      location: createRunStorageLocation(
        absolutePath,
        normalizedPath,
        executionId,
      ),
    };
  }
  if (isDirectory(type)) return { kind: 'directory', absolutePath };
  return { kind: 'unsupported', absolutePath };
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

/**
 * Recover execution identity from an absolute run-storage path.
 *
 * The released extension may retain transcripts and resume records containing
 * absolute `taskRuns` paths. Keep parsing those paths without probing the
 * filesystem until that released-data retention policy expires (#6981).
 */
export function runStorageLocationFromAnyAbsolutePath(
  absolutePath: string,
): RunStorageFileLocation | undefined {
  if (!path.isAbsolute(absolutePath)) return undefined;

  const roots = [
    StorageFS.fullPath(resolveRunStoragePath()),
    StorageFS.fullPath(WORKSPACE_STORAGE_LAYOUT.legacyRuns),
  ];
  for (const root of roots) {
    const runRelativePath = resolveRunStorageRelativePath(absolutePath, root);
    if (!runRelativePath) continue;

    const [rawExecutionId, ...entrySegments] = getPathSegments(runRelativePath);
    const executionId = ExecutionIdSchema.safeParse(rawExecutionId);
    if (!executionId.success || entrySegments.length === 0) return undefined;

    const relativePath = entrySegments.join('/');
    return createRunStorageLocation(
      path.resolve(root, runRelativePath),
      relativePath,
      executionId.data,
    );
  }

  return undefined;
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

/** Errno codes for which symlink creation is unavailable and a copy is used instead. */
const SYMLINK_UNSUPPORTED_CODES = new Set([
  'EPERM',
  'EACCES',
  'EINVAL',
  'ENOTSUP',
]);

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
    if (err.code && SYMLINK_UNSUPPORTED_CODES.has(err.code)) {
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
