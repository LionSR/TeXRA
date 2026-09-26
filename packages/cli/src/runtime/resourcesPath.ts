import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Data, Effect, FileSystem } from 'effect';

import { absentReason } from '@utils/files/fsEntryExists';

/** No resources candidate exists beside this build of the CLI. */
class CliResourcesNotFound extends Data.TaggedError('CliResourcesNotFound')<{
  readonly message: string;
}> {}

/** Whether `target` exists; an absent path (ENOENT or ENOTDIR) reads as
 *  `false`, and any other failure propagates. */
const isPresent = (fs: FileSystem.FileSystem, target: string) =>
  fs
    .exists(target)
    .pipe(Effect.catchIf(absentReason, () => Effect.succeed(false)));

export const resolveCliResourcesPath = Effect.fn(
  'resourcesPath.resolveCliResourcesPath',
)(function* (anchorUrl: string = import.meta.url) {
  const fs = yield* FileSystem.FileSystem;
  const currentDir = path.dirname(fileURLToPath(anchorUrl));
  // The nearest `cli` ancestor holding a package.json, or the anchor's own
  // directory when there is none.
  let packageDir = currentDir;
  for (let dir = currentDir; ; dir = path.dirname(dir)) {
    if (
      path.basename(dir) === 'cli' &&
      (yield* isPresent(fs, path.join(dir, 'package.json')))
    ) {
      packageDir = dir;
      break;
    }
    if (path.dirname(dir) === dir) break;
  }
  const candidates = [
    path.resolve(currentDir, '../resources'),
    path.resolve(packageDir, 'dist/resources'),
    path.resolve(packageDir, '../extension/resources'),
  ];
  for (const candidate of candidates) {
    if (yield* isPresent(fs, candidate)) return candidate;
  }
  return yield* new CliResourcesNotFound({
    message: `TeXRA CLI resources not found; looked in: ${candidates.join(', ')}`,
  });
});
