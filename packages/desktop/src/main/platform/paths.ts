import { join } from 'node:path';

import { Effect, FileSystem, Schema } from 'effect';

import { BUNDLED_AGENTS_DIRECTORY } from '@texra-ai/harness/host';
import { meansAbsent } from '@texra-ai/harness/node';

/** The app's resources directory holds no bundled agents. */
class DesktopResourcesNotFound extends Schema.TaggedError<DesktopResourcesNotFound>()(
  'DesktopResourcesNotFound',
  {
    message: Schema.String,
  },
) {}

/** Where this build's files are. */
export type DesktopLayout = ReturnType<typeof desktopLayout>;

/**
 * Where this build's files are, from the directory of the entry module
 * (`dist/main/index.js`, `main` in package.json), which sits beside the
 * built preload script and renderer page. The bundled extension tree is the
 * packaged app's `Resources/` (`extraResources` in `electron-builder.yml`),
 * or in a development run the extension package beside this one.
 */
export function desktopLayout(mainDir: string, isPackaged: boolean) {
  const extension = isPackaged
    ? process.resourcesPath
    : join(mainDir, '../../../extension');
  return {
    preload: join(mainDir, '../preload/index.cjs'),
    rendererPage: join(mainDir, '../renderer/index.html'),
    /** The `packages/extension/resources` tree. */
    resourcesPath: join(extension, 'resources'),
    /** The directory the background service's bundle (`serve/`) is in. */
    serviceRoot: extension,
  };
}

/** `resourcesPath`, failing by its path when it holds no bundled agents. */
export const checkResourcesPath = Effect.fn('checkResourcesPath')(function* (
  resourcesPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (
    !(yield* isExistingDirectory(
      fs,
      join(resourcesPath, BUNDLED_AGENTS_DIRECTORY),
    ))
  )
    return yield* new DesktopResourcesNotFound({
      message: `Unable to locate TeXRA resources: ${resourcesPath} holds no ${BUNDLED_AGENTS_DIRECTORY}/ directory`,
    });
  return resourcesPath;
});

const isExistingDirectory = (fs: FileSystem.FileSystem, path: string) =>
  fs.stat(path).pipe(
    Effect.map((info) => info.type === 'Directory'),
    Effect.catchIf(meansAbsent, () => Effect.succeed(false)),
  );
