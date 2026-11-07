import { dirname, join } from 'node:path';

import { Effect, FileSystem, Schema } from 'effect';

import { BUNDLED_AGENTS_DIRECTORY } from '@texra-ai/harness/host';
import { absentReason, pathExists } from '@texra-ai/harness/node';

/** No resources candidate holds every bundled agent directory. */
class DesktopResourcesNotFound extends Schema.TaggedError<DesktopResourcesNotFound>()(
  'DesktopResourcesNotFound',
  {
    message: Schema.String,
  },
) {}

/**
 * The directory holding the built main bundle: the nearest of `startDir` and
 * its two ancestors that sits beside the built preload script and renderer
 * page, or `startDir` itself when none does.
 */
export const resolveDesktopMainDir = Effect.fn('resolveDesktopMainDir')(
  function* (startDir: string) {
    const fs = yield* FileSystem.FileSystem;
    let currentDir = startDir;
    for (let depth = 0; depth < 3; depth += 1) {
      if (
        (yield* pathExists(fs, join(currentDir, '../preload/index.cjs'))) &&
        (yield* pathExists(fs, join(currentDir, '../renderer/index.html')))
      ) {
        return currentDir;
      }
      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }
    return startDir;
  },
);

/**
 * The bundled `packages/extension/resources` tree: beside the packaged app's
 * `Resources/` (`extraResources` in `electron-builder.yml`), or the extension
 * package's own copy in a development run from `packages/desktop/dist/main`.
 */
export const resolveResourcesPath = Effect.fn('resolveResourcesPath')(
  function* (mainDirname: string) {
    const fs = yield* FileSystem.FileSystem;
    const resourcesPath = process.resourcesPath;
    const candidates = [
      resourcesPath ? join(resourcesPath, 'resources') : undefined,
      join(mainDirname, '../../../extension/resources'),
    ].filter((candidate): candidate is string => Boolean(candidate));

    for (const candidate of candidates) {
      if (yield* hasRequiredResourceDirectories(fs, candidate)) {
        return candidate;
      }
    }
    return yield* new DesktopResourcesNotFound({
      message: `Unable to locate TeXRA resources. Checked: ${candidates.join(', ')}`,
    });
  },
);

const hasRequiredResourceDirectories = Effect.fn(
  'hasRequiredResourceDirectories',
)(function* (fs: FileSystem.FileSystem, candidate: string) {
  for (const path of [candidate, join(candidate, BUNDLED_AGENTS_DIRECTORY)]) {
    if (!(yield* isExistingDirectory(fs, path))) return false;
  }
  return true;
});

const isExistingDirectory = (fs: FileSystem.FileSystem, path: string) =>
  fs.stat(path).pipe(
    Effect.map((info) => info.type === 'Directory'),
    Effect.catchIf(absentReason, () => Effect.succeed(false)),
  );
