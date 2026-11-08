import { dirname, join } from 'node:path';

import { Effect, FileSystem, Schema } from 'effect';

import { BUNDLED_AGENTS_DIRECTORY } from '@texra-ai/harness/host';
import { absentReason, pathExists } from '@texra-ai/harness/node';

/** The app's resources directory holds no bundled agents. */
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
 * Which one is Electron's `app.isPackaged`, so nothing is searched; the one
 * place fails by its path when it holds no bundled agents.
 */
export const resolveResourcesPath = Effect.fn('resolveResourcesPath')(
  function* (mainDirname: string, isPackaged: boolean) {
    const fs = yield* FileSystem.FileSystem;
    const resources = isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(mainDirname, '../../../extension/resources');
    if (
      !(yield* isExistingDirectory(
        fs,
        join(resources, BUNDLED_AGENTS_DIRECTORY),
      ))
    )
      return yield* new DesktopResourcesNotFound({
        message: `Unable to locate TeXRA resources: ${resources} holds no ${BUNDLED_AGENTS_DIRECTORY}/ directory`,
      });
    return resources;
  },
);

const isExistingDirectory = (fs: FileSystem.FileSystem, path: string) =>
  fs.stat(path).pipe(
    Effect.map((info) => info.type === 'Directory'),
    Effect.catchIf(absentReason, () => Effect.succeed(false)),
  );
