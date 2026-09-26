/**
 * One process-wide exclusive lane per file, for a read-modify-write of it: an
 * edit reads the file, changes the text and writes it whole, with I/O (for an
 * approved edit, minutes of waiting) in between, while parallel runs edit the
 * same files. Keyed by the file's real path, so every writer of one file meets
 * on one lane whatever view or symlink it names it through; `withPerKeyLane`
 * deletes a lane once idle.
 */
import * as nodePath from 'node:path';

import { Effect, FileSystem } from 'effect';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';

const fileLanes = new Map<string, PerKeyLane>();

/** The real path of `file`, or, for one not created yet, its nearest existing
 *  ancestor's real path joined with the rest. Only the lane key: whatever the
 *  I/O itself fails on, the operation run on the lane reports. */
function realPathOf(
  fs: FileSystem.FileSystem,
  file: string,
): Effect.Effect<string> {
  const parent = nodePath.dirname(file);
  return fs
    .realPath(file)
    .pipe(
      Effect.catch(() =>
        parent === file
          ? Effect.succeed(file)
          : realPathOf(fs, parent).pipe(
              Effect.map((dir) => nodePath.join(dir, nodePath.basename(file))),
            ),
      ),
    );
}

/** Run `self` holding the lane of every file in `files`, taken in one sorted
 *  order so two operations over overlapping files never wait on each other. */
export function onFileLanes(files: readonly string[]) {
  return <A, E, R>(
    self: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R | FileSystem.FileSystem> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const keys = yield* Effect.forEach(files, (file) =>
        realPathOf(fs, nodePath.resolve(file)),
      );
      return yield* [...new Set(keys)]
        .sort()
        .reduceRight<Effect.Effect<A, E, R>>(
          (inner, key) => inner.pipe(withPerKeyLane(fileLanes, key)),
          self,
        );
    });
}
