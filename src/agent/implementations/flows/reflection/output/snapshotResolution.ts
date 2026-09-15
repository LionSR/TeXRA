/**
 * Resolves base files to their pre-run snapshot for diff computation.
 *
 * `prepareRunWorkspace` copies each workspace base file into
 * `executions/<id>/original/<relativePath>` before any agent edits run.
 * In-place workflows overwrite the live workspace file, so diffing
 * against the live path yields 0/0; the snapshot preserves the
 * canonical "before" content for accurate stats.
 */

import { Effect } from 'effect';

import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { RunId, FileLocation } from '@shared/schemas';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { createRunStorageLocation } from '@utils/files/fileLocation';
import { originalSnapshotPathUnder } from '@utils/files/runStorageFs';

import { fsCall } from '@utils/errors/fsCall';
/** Map each workspace base file to its snapshot location when one exists.
 *  Non-workspace files and missing snapshots pass through unchanged. The
 *  snapshot is looked up under the run's own session storage root. */
export const resolveBaseFilesForDiff = Effect.fn(
  'reflection.resolveBaseFilesForDiff',
)(function* (baseFiles: FileLocation[], runId: RunId, roots: WorkspaceRoots) {
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
        if (!(yield* fsCall(() => AbsoluteFS.isFile(snapshotAbsolute)))) {
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
