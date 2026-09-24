// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, PlatformError } from 'effect';

// Local imports
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { withLogChannel } from '@logger/effectLog';
import {
  RunIdSchema,
  type RunId,
  type RunStorageFileLocation,
} from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { normalizeFilePath } from '@utils/core';
import { getPathSegments, isPathWithin } from '@utils/core/pathCore';

// Local file imports
import { createRunStorageLocation } from './fileLocation';
import { entryExists, entryTypeIn } from './fsEntryExists';

export const CHANNEL = 'runStorage';

/*
 * Every path helper below takes the storage root as data. A caller holds that
 * root already — a tool call's `roots`, a run's session roots, or a host's
 * `WorkspaceRoots` — so none of them reads an ambient root (#12421).
 */

/** A storage-relative (POSIX) path under the runs directory. */
export function resolveRunStoragePath(...segments: string[]): string {
  return path.posix.join(WORKSPACE_STORAGE_LAYOUT.runs, ...segments);
}

function runStorageRelativePath(
  absolutePath: string,
  runDirectory: string,
): string | undefined {
  if (!isPathWithin(runDirectory, absolutePath)) return undefined;
  return (
    normalizeFilePath(path.relative(runDirectory, absolutePath)) || undefined
  );
}

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
    resolveRunStoragePath(
      runId,
      WORKSPACE_STORAGE_LAYOUT.original,
      workspaceRelativePath,
    ),
  );
}

/**
 * The run-storage-relative path of `segments` under `storageRoot` when it
 * exists, so a caller that addresses run storage by relative path (the
 * storage view's own vocabulary) keeps doing so.
 */
export const findExistingRunStoragePathUnder = Effect.fn(
  'runStorage.findExistingRunStoragePath',
)(function* (storageRoot: string, ...segments: string[]) {
  const fs = yield* FileSystem.FileSystem;
  const storagePath = resolveRunStoragePath(...segments);
  return (yield* entryExists(fs, path.join(storageRoot, storagePath)))
    ? storagePath
    : undefined;
});

/** A run's directory under `storageRoot`, when that directory exists. */
export const findRunDirUnder = Effect.fn('runStorage.findRunDir')(function* (
  storageRoot: string,
  id: RunId,
) {
  const rel = yield* findExistingRunStoragePathUnder(storageRoot, id);
  return rel ? path.join(storageRoot, rel) : undefined;
});

type RunStorageEntryInspection =
  | { readonly kind: 'file'; readonly location: RunStorageFileLocation }
  | {
      readonly kind: 'symlink' | 'directory' | 'unsupported';
      readonly absolutePath: string;
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Inspect one run-relative run-storage entry under `storageRoot` without
 * following a workspace-mirror symlink.
 */
export const inspectRunStorageEntryUnder = Effect.fn(
  'runStorage.inspectRunStorageEntry',
)(function* (
  storageRoot: string,
  runId: RunId,
  relativePath: string,
): Effect.fn.Return<
  RunStorageEntryInspection,
  PlatformError.PlatformError,
  FileSystem.FileSystem
> {
  const fs = yield* FileSystem.FileSystem;
  const posixPath = normalizeFilePath(relativePath);
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
    const ancestorType = yield* entryTypeIn(fs, ancestorPath);
    if (ancestorType === undefined) return { kind: 'missing' };
    if (ancestorType === 'SymbolicLink') {
      return { kind: 'symlink', absolutePath: ancestorPath };
    }
    if (ancestorType !== 'Directory') {
      return { kind: 'unsupported', absolutePath: ancestorPath };
    }
  }

  const absolutePath = path.join(storageRoot, entry);
  const type = yield* entryTypeIn(fs, absolutePath);
  if (type === undefined) return { kind: 'missing' };
  if (type === 'SymbolicLink') return { kind: 'symlink', absolutePath };
  if (type === 'File') {
    return {
      kind: 'file',
      location: createRunStorageLocation(absolutePath, normalizedPath, runId),
    };
  }
  if (type === 'Directory') return { kind: 'directory', absolutePath };
  return { kind: 'unsupported', absolutePath };
});

/** Create a run's directory under `storageRoot`, runs directory included. */
export const ensureRunDirUnder = Effect.fn('runStorage.ensureRunDir')(
  function* (storageRoot: string, id: RunId) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(runDirUnder(storageRoot, id), { recursive: true });
  },
);

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
  const relativePath = runStorageRelativePath(
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
  const runRelativePath = runStorageRelativePath(absolutePath, root);
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

export const ensureParentDir = Effect.fn('runStorage.ensureParentDir')(
  function* (filePath: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  },
);

/** Non-ENOENT stat failures fail the check so a permissions error never silently forces a re-copy over a real snapshot. */
export const snapshotExists = Effect.fn('runStorage.snapshotExists')(function* (
  absolutePath: string,
): Effect.fn.Return<boolean, Error, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.stat(absolutePath).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => error.reason._tag === 'NotFound',
      () => Effect.succeed(false),
    ),
    Effect.mapError(
      (error) =>
        new Error(
          `Failed to inspect snapshot destination ${absolutePath}: ${toErrorMessage(error)}`,
          { cause: error },
        ),
    ),
  );
});

/** Errno codes for which symlink creation is unavailable and a copy is used instead. */
const SYMLINK_UNSUPPORTED_CODES = new Set([
  'EPERM',
  'EACCES',
  'EINVAL',
  'ENOTSUP',
]);

export const createSymlink = Effect.fn('runStorage.createSymlink')(function* (
  sourceAbsolute: string,
  destination: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* ensureParentDir(destination);
  yield* fs.symlink(sourceAbsolute, destination).pipe(
    // One recovery, exactly as the one `catch` it replaces: an existing
    // destination is replaced (the anti-clobber rule lives with the callers
    // that decide what may be replaced, never here), a host that cannot make
    // links copies instead, and a second failure of either propagates rather
    // than re-entering this branch.
    Effect.catch((error) => {
      if (error.reason._tag === 'AlreadyExists') {
        return fs
          .remove(destination, { recursive: true, force: true })
          .pipe(Effect.andThen(fs.symlink(sourceAbsolute, destination)));
      }
      const code = (error.reason.cause as NodeJS.ErrnoException | undefined)
        ?.code;
      if (!code || !SYMLINK_UNSUPPORTED_CODES.has(code)) {
        return Effect.fail(error);
      }
      return Effect.gen(function* () {
        yield* Effect.logWarning(
          `Falling back to copy ${sourceAbsolute} -> ${destination} due to ${code}`,
        ).pipe(withLogChannel(CHANNEL));
        const sourceType = yield* entryTypeIn(fs, sourceAbsolute);
        yield* sourceType === 'Directory'
          ? fs.copy(sourceAbsolute, destination, { overwrite: true })
          : fs.copyFile(sourceAbsolute, destination);
      });
    }),
  );
});

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
