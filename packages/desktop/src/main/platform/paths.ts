import { dirname, join } from 'node:path';

import { Config, Effect, FileSystem, Option, Schema } from 'effect';

import { BUNDLED_AGENTS_DIRECTORY } from '@texra-ai/harness/host';
import { absentReason, pathExists } from '@texra-ai/harness/node';
import { defaultNodeStorageRoot } from '@texra/platform/defaults/nodeStorage';

/** The app's resources directory holds no bundled agents. */
class DesktopResourcesNotFound extends Schema.TaggedError<DesktopResourcesNotFound>()(
  'DesktopResourcesNotFound',
  {
    message: Schema.String,
  },
) {}

/**
 * Root directory for desktop-persisted memory/history/executions data.
 *
 * Production desktop shares the CLI's `~/.texra` root ({@link
 * defaultNodeStorageRoot}) so a workspace worked on from both hosts shows
 * one memory/history view (#7987). The e2e/dev harness isolates Electron's
 * own `userData` profile via `TEXRA_DESKTOP_E2E_USER_DATA_PATH` (see
 * `packages/desktop/src/main/bootstrap.ts`) so relaunches share one throwaway
 * profile without ever touching a developer's real `~/.texra`; when that var
 * is set, the data root stays colocated with that same isolated profile
 * (`userDataPath` is already the isolated path by the time this runs). The
 * variable comes from the ambient Effect `ConfigProvider`.
 */
export const resolveDesktopDataRoot = Effect.fn('resolveDesktopDataRoot')(
  function* (userDataPath: string) {
    const e2eUserDataPath = yield* Config.String(
      'TEXRA_DESKTOP_E2E_USER_DATA_PATH',
    ).pipe(Config.option, Effect.orDie);
    return Option.getOrUndefined(e2eUserDataPath)?.trim()
      ? userDataPath
      : defaultNodeStorageRoot();
  },
);

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
