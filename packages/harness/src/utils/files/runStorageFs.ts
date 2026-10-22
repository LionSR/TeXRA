// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Path } from 'effect';

// Local imports
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { withLogChannel } from '@logger/effectLog';
import { StorageFs, WorkspaceFs } from '@platform/rootedFs';
import {
  RunIdSchema,
  type RunId,
  type RunStorageFileLocation,
} from '@shared/schemas';
import { normalizeFilePath } from '@utils/core';
import { getPathSegments, isPathWithin } from '@utils/core/pathCore';

// Local file imports
import { createRunStorageLocation } from './fileLocation';
import { copyDereferenced } from './fsDurability';
import { entryExists, entryTypeIn } from './fsEntryExists';

export const CHANNEL = 'runStorage';

/*
 * Every path helper below takes the storage root as data. A caller holds that
 * root already — a tool call's `roots`, a run's session roots, or a host's
 * `WorkspaceRoots` — so none of them reads an ambient root (#12421).
 */

/** A storage-relative (POSIX) path under the runs directory. */
function resolveRunStoragePath(...segments: string[]): string {
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
    // One recovery: an existing link is replaced, while any other entry (a
    // file the run wrote) fails `AlreadyExists` and stays; a host that cannot
    // make links copies instead, and a second failure of either propagates
    // rather than re-entering this branch.
    Effect.catch((error) => {
      if (error.reason._tag === 'AlreadyExists') {
        return entryTypeIn(fs, destination).pipe(
          Effect.flatMap((type) =>
            type === 'SymbolicLink'
              ? fs
                  .remove(destination)
                  .pipe(Effect.andThen(fs.symlink(sourceAbsolute, destination)))
              : Effect.fail(error),
          ),
        );
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

/**
 * Copy a stopped run's directory to the workspace path `to`, or remove it;
 * `false` when the run has no directory. Symlinks are dereferenced so a copy
 * stands alone, and a copy onto an existing folder fails rather than merging
 * into it.
 */
export const copyOrRemoveRunDir = Effect.fn('runStorage.copyOrRemoveRunDir')(
  function* (
    runId: RunId,
    files:
      { readonly op: 'copy'; readonly to: string } | { readonly op: 'remove' },
  ) {
    const storageFs = yield* StorageFs;
    const runDir = resolveRunStoragePath(runId);
    if (!(yield* storageFs.exists(runDir))) {
      yield* Effect.logWarning(`Run directory not found for run ${runId}`);
      return false;
    }
    if (files.op === 'remove') {
      yield* Effect.logInfo(`Removing the run directory ${runDir}`);
      yield* storageFs.remove(runDir, { recursive: true, force: true });
      return true;
    }
    const workspaceFs = yield* WorkspaceFs;
    const source = yield* storageFs.resolve(runDir);
    const destination = yield* workspaceFs.resolve(files.to);
    yield* workspaceFs.makeDirectory((yield* Path.Path).dirname(files.to), {
      recursive: true,
    });
    yield* copyDereferenced(source, destination);
    yield* Effect.logInfo(`Copied ${source} -> ${destination}`);
    return true;
  },
);
