import { dirname, join } from 'node:path';

import { app } from 'electron';
import { Data, Effect, FileSystem } from 'effect';

import { BUNDLED_AGENT_DIRECTORY_NAMES } from '@agent/index';
import { DEFAULT_NODE_STORAGE_ROOT } from '@platform/defaults/nodeStorage';
import { absentReason } from '@utils/files/fsEntryExists';
import { envVar } from '@utils/system/envFlags';

/** No resources candidate holds every bundled agent directory. */
class DesktopResourcesNotFound extends Data.TaggedError(
  'DesktopResourcesNotFound',
)<{ readonly message: string }> {}

interface ResourcesPathOptions {
  appPath?: string;
  resourcesPath?: string;
}

/**
 * Root directory for desktop-persisted memory/history/executions data.
 *
 * Production desktop shares the CLI's `~/.texra` root ({@link
 * DEFAULT_NODE_STORAGE_ROOT}) so a workspace worked on from both hosts shows
 * one memory/history view (#7987). The e2e/dev harness isolates Electron's
 * own `userData` profile via `TEXRA_DESKTOP_E2E_USER_DATA_PATH` (see
 * `packages/desktop/src/main/index.ts`) so relaunches share one throwaway
 * profile without ever touching a developer's real `~/.texra`; when that var
 * is set, the data root stays colocated with that same isolated profile
 * (`userDataPath` is already the isolated path by the time this runs). The
 * variable comes from the ambient Effect `ConfigProvider`.
 */
export const resolveDesktopDataRoot = Effect.fn('resolveDesktopDataRoot')(
  function* (userDataPath: string) {
    const e2eUserDataPath = yield* envVar('TEXRA_DESKTOP_E2E_USER_DATA_PATH');
    return e2eUserDataPath?.trim() ? userDataPath : DEFAULT_NODE_STORAGE_ROOT;
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
        (yield* isPresent(fs, join(currentDir, '../preload/index.cjs'))) &&
        (yield* isPresent(fs, join(currentDir, '../renderer/index.html')))
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

export const resolveResourcesPath = Effect.fn('resolveResourcesPath')(
  function* (mainDirname: string, options: ResourcesPathOptions = {}) {
    const fs = yield* FileSystem.FileSystem;
    const appPath = options.appPath ?? app.getAppPath();
    const resourcesPath = options.resourcesPath ?? process.resourcesPath;
    const candidates = [
      join(appPath, 'resources'),
      resourcesPath ? join(resourcesPath, 'resources') : undefined,
      join(mainDirname, '../../../extension/resources'),
      join(mainDirname, '../../../../resources'),
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
  for (const path of [
    candidate,
    ...BUNDLED_AGENT_DIRECTORY_NAMES.map((name) => join(candidate, name)),
  ]) {
    if (!(yield* isExistingDirectory(fs, path))) return false;
  }
  return true;
});

const isPresent = (fs: FileSystem.FileSystem, path: string) =>
  fs
    .exists(path)
    .pipe(Effect.catchIf(absentReason, () => Effect.succeed(false)));

const isExistingDirectory = (fs: FileSystem.FileSystem, path: string) =>
  fs.stat(path).pipe(
    Effect.map((info) => info.type === 'Directory'),
    Effect.catchIf(absentReason, () => Effect.succeed(false)),
  );
