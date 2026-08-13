/**
 * Resolves base files to their pre-run snapshot for diff computation.
 *
 * `prepareRunWorkspace` copies each workspace base file into
 * `executions/<id>/original/<relativePath>` before any agent edits run.
 * In-place workflows overwrite the live workspace file, so diffing
 * against the live path yields 0/0; the snapshot preserves the
 * canonical "before" content for accurate stats.
 */

import type { ExecutionId, FileLocation } from '@shared/schemas';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { createRunStorageLocation } from '@utils/files/fileLocation';
import { getOriginalSnapshotPath } from '@utils/files/runStorageFs';

/** Map each workspace base file to its snapshot location when one exists.
 *  Non-workspace files and missing snapshots pass through unchanged. */
export async function resolveBaseFilesForDiff(
  baseFiles: FileLocation[],
  executionId: ExecutionId | undefined,
): Promise<FileLocation[]> {
  if (executionId === undefined) return baseFiles;
  return Promise.all(
    baseFiles.map(async (loc) => {
      if (loc.kind !== 'workspace') return loc;
      const snapshotAbsolute = getOriginalSnapshotPath(
        executionId,
        loc.relativePath,
      );
      if (!(await AbsoluteFS.isFile(snapshotAbsolute))) return loc;
      return createRunStorageLocation(
        snapshotAbsolute,
        loc.relativePath,
        executionId,
      );
    }),
  );
}
