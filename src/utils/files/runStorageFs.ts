// Node imports
import * as path from 'node:path';
import { promises as fs } from 'node:fs';

// Local imports
import { isFileNotFoundError } from '@common/errors';
import { createLog } from '@logger/logUtils';
import {
  resolveRunOriginalSnapshotPath,
  resolveRunStoragePath,
  resolveRunStorageRelativePath,
  RUNS_STORAGE_DIR,
} from '@platform/defaults/workspaceStorage';
import {
  RunIdSchema,
  type RunId,
  type RunStorageFileLocation,
} from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { getPathSegments } from '@utils/core/pathCore';

// Local file imports
import { createRunStorageLocation } from './fileLocation';
import { AbsoluteFS } from './absoluteFS';
import { isDirectory, isFile, isSymlink } from './fsEntryType';

export const CHANNEL = 'runStorage';
const log = createLog(CHANNEL);

/*
 * Every path helper below takes the storage root as data. A caller holds that
 * root already — a tool call's `roots`, a run's session roots, or a host's
 * `WorkspaceRoots` — so none of them reads an ambient root (#12421).
 */

/** A run's directory under `storageRoot`. */
export function runDirUnder(storageRoot: string, id: RunId): string {
  return path.join(storageRoot, resolveRunStoragePath(id));
}

/** A workspace file's pre-run snapshot path under `storageRoot`. */
export function originalSnapshotPathUnder(
  storageRoot: string,
  runId: RunId,
  workspaceRelativePath: string,
): string {
  return path.join(
    storageRoot,
    resolveRunOriginalSnapshotPath(runId, workspaceRelativePath),
  );
}

/**
 * The run-storage-relative path of `segments` under `storageRoot` when it
 * exists, so a caller that addresses run storage by relative path (the
 * storage view's own vocabulary) keeps doing so.
 */
export async function findExistingRunStoragePathUnder(
  storageRoot: string,
  ...segments: string[]
): Promise<string | undefined> {
  const storagePath = resolveRunStoragePath(...segments);
  return (await AbsoluteFS.exists(path.join(storageRoot, storagePath)))
    ? storagePath
    : undefined;
}

/** A run's directory under `storageRoot`, when that directory exists. */
export async function findRunDirUnder(
  storageRoot: string,
  id: RunId,
): Promise<string | undefined> {
  const rel = await findExistingRunStoragePathUnder(storageRoot, id);
  return rel ? path.join(storageRoot, rel) : undefined;
}

type RunStorageEntryInspection =
  | { readonly kind: 'file'; readonly location: RunStorageFileLocation }
  | {
      readonly kind: 'symlink' | 'directory' | 'unsupported';
      readonly absolutePath: string;
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly reason: string };

async function storageEntryType(
  absolutePath: string,
): Promise<number | undefined> {
  try {
    return (await AbsoluteFS.stat(absolutePath)).type;
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  }
}

/**
 * Inspect one run-relative run-storage entry under `storageRoot` without
 * following a workspace-mirror symlink.
 */
export async function inspectRunStorageEntryUnder(
  storageRoot: string,
  runId: RunId,
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

  const root = resolveRunStoragePath(runId);
  const entry = resolveRunStoragePath(runId, normalizedPath);
  // Every directory the walk below descends through, run root first, with the
  // entry's own path excluded: one path per prefix of `pathSegments`.
  const ancestors = [
    root,
    ...pathSegments
      .slice(0, -1)
      .map((_, index) =>
        resolveRunStoragePath(runId, ...pathSegments.slice(0, index + 1)),
      ),
  ];
  for (const ancestor of ancestors) {
    const ancestorPath = path.join(storageRoot, ancestor);
    const ancestorType = await storageEntryType(ancestorPath);
    if (ancestorType === undefined) return { kind: 'missing' };
    if (isSymlink(ancestorType)) {
      return { kind: 'symlink', absolutePath: ancestorPath };
    }
    if (!isDirectory(ancestorType)) {
      return { kind: 'unsupported', absolutePath: ancestorPath };
    }
  }

  const absolutePath = path.join(storageRoot, entry);
  const type = await storageEntryType(absolutePath);
  if (type === undefined) return { kind: 'missing' };
  if (isSymlink(type)) return { kind: 'symlink', absolutePath };
  if (isFile(type)) {
    return {
      kind: 'file',
      location: createRunStorageLocation(absolutePath, normalizedPath, runId),
    };
  }
  if (isDirectory(type)) return { kind: 'directory', absolutePath };
  return { kind: 'unsupported', absolutePath };
}

/** Create the runs directory and a run's directory under `storageRoot`. */
export async function ensureRunDirUnder(
  storageRoot: string,
  id: RunId,
): Promise<void> {
  await AbsoluteFS.ensureDir(path.join(storageRoot, RUNS_STORAGE_DIR));
  await AbsoluteFS.ensureDir(runDirUnder(storageRoot, id));
}

/** An absolute path inside a run's directory under `storageRoot`. */
export function runStorageAbsolutePathUnder(
  storageRoot: string,
  id: RunId,
  workspaceRelative: string,
): string {
  return path.join(storageRoot, resolveRunStoragePath(id, workspaceRelative));
}

/** Locate `absolutePath` inside one named run's directory under `storageRoot`. */
export function runStorageLocationInRunUnder(
  storageRoot: string,
  absolutePath: string,
  runId: RunId,
): RunStorageFileLocation | undefined {
  if (!path.isAbsolute(absolutePath)) return undefined;
  const relativePath = resolveRunStorageRelativePath(
    absolutePath,
    runDirUnder(storageRoot, runId),
  );
  if (!relativePath) return undefined;
  return createRunStorageLocation(absolutePath, relativePath, runId);
}

/**
 * Recover run identity from an absolute path inside the runs directory under
 * `storageRoot`.
 */
export function runStorageLocationUnder(
  storageRoot: string,
  absolutePath: string,
): RunStorageFileLocation | undefined {
  if (!path.isAbsolute(absolutePath)) return undefined;

  const root = path.join(storageRoot, resolveRunStoragePath());
  const runRelativePath = resolveRunStorageRelativePath(absolutePath, root);
  if (!runRelativePath) return undefined;

  const [rawRunId, ...entrySegments] = getPathSegments(runRelativePath);
  const runId = RunIdSchema.safeParse(rawRunId);
  if (!runId.success || entrySegments.length === 0) return undefined;

  return createRunStorageLocation(
    path.resolve(root, runRelativePath),
    entrySegments.join('/'),
    runId.data,
  );
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
      log.warn(
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
 * History folders contain prior run data that is managed separately,
 * so keep them in place even when run-storage isolation is enabled.
 */
const IGNORED_WORKSPACE_ROOTS = new Set(['History', 'history']);

export function shouldSkipRelocation(relativePath: string): boolean {
  const segments = getPathSegments(relativePath);
  return segments.length > 0 && IGNORED_WORKSPACE_ROOTS.has(segments[0]);
}
