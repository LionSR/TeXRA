import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Data, Effect, FileSystem } from 'effect';

import { pathExists } from '@utils/files/fsDurability';

/** No resources candidate exists beside this build of the CLI. */
class CliResourcesNotFound extends Data.TaggedError('CliResourcesNotFound')<{
  readonly message: string;
}> {}

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
      (yield* pathExists(fs, path.join(dir, 'package.json')))
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
    if (yield* pathExists(fs, candidate)) return candidate;
  }
  return yield* new CliResourcesNotFound({
    message: `TeXRA CLI resources not found; looked in: ${candidates.join(', ')}`,
  });
});
