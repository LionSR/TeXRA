// Node imports
import * as nodePath from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';

// Local imports - utils
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';

/**
 * One process-wide lane per file, for every writer that reads a file,
 * decides and writes it back: an approved edit merging onto what is there,
 * an editor's save checking what it last read. Two writers on two maps
 * would each pass their check and the later write would replace the
 * earlier unseen. Keyed by the file's real path (a new file's nearest
 * existing ancestor's, joined with the rest), so a symlink and its target
 * meet on one lane.
 */
const fileWriteLanes = new Map<string, PerKeyLane>();

function realPathOf(
  fs: FileSystem.FileSystem,
  file: string,
): Effect.Effect<string> {
  const parent = nodePath.dirname(file);
  return fs.realPath(file).pipe(
    // Only the lane key: whatever the I/O fails on, the write reports.
    Effect.catch(() =>
      parent === file
        ? Effect.succeed(file)
        : realPathOf(fs, parent).pipe(
            Effect.map((dir) => nodePath.join(dir, nodePath.basename(file))),
          ),
    ),
  );
}

/** Run `self`, a read, decision and write of `file`, as the file's one
 *  writer in this process. `file` is absolute. */
export const withFileWriteLane =
  (file: string) =>
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R | FileSystem.FileSystem> =>
    Effect.flatMap(
      Effect.flatMap(FileSystem.FileSystem, (fs) =>
        realPathOf(fs, nodePath.resolve(file)),
      ),
      (key) => self.pipe(withPerKeyLane(fileWriteLanes, key)),
    );
