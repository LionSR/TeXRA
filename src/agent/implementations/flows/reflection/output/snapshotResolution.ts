/**
 * Resolves base files to their pre-run snapshot for diff computation.
 *
 * `prepareRunWorkspace` copies each workspace base file into
 * `executions/<id>/original/<relativePath>` before any agent edits run.
 * In-place workflows overwrite the live workspace file, so diffing
 * against the live path yields 0/0; the snapshot preserves the
 * canonical "before" content for accurate stats.
 */

import { Effect, FileSystem } from 'effect';

import { isNotADirectoryError } from '@common/errors';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { RunId, FileLocation } from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';
import { createRunStorageLocation } from '@utils/files/fileLocation';
import { originalSnapshotPathUnder } from '@utils/files/runStorageFs';

/** ENOENT, or ENOTDIR on a parent, as `AbsoluteFS.isFile` via `statIfExists` treated them. */
function isAbsentFsPath(error: {
  readonly reason: { readonly _tag: string; readonly cause: unknown };
}): boolean {
  return (
    error.reason._tag === 'NotFound' ||
    (error.reason._tag === 'BadResource' &&
      isNotADirectoryError(error.reason.cause))
  );
}

/** Map each workspace base file to its snapshot location when one exists.
 *  Non-workspace files and missing snapshots pass through unchanged. The
 *  snapshot is looked up under the run's own session storage root. */
export const resolveBaseFilesForDiff = Effect.fn(
  'reflection.resolveBaseFilesForDiff',
)(function* (
  baseFiles: FileLocation[],
  runId: RunId,
  roots: WorkspaceRoots,
): Effect.fn.Return<FileLocation[], Error, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.forEach(
    baseFiles,
    (loc) =>
      Effect.gen(function* () {
        if (loc.kind !== 'workspace') return loc;
        const snapshotAbsolute = originalSnapshotPathUnder(
          roots.storage,
          runId,
          loc.relativePath,
        );
        // `stat` follows a link, as the `isFile` this replaces did.
        const isFile = yield* fs.stat(snapshotAbsolute).pipe(
          Effect.map((info) => info.type === 'File'),
          Effect.catchIf(isAbsentFsPath, () => Effect.succeed(false)),
          Effect.mapError(ensureError),
        );
        if (!isFile) {
          return loc;
        }
        return createRunStorageLocation(
          snapshotAbsolute,
          loc.relativePath,
          runId,
        );
      }),
    { concurrency: 'unbounded' },
  );
});
