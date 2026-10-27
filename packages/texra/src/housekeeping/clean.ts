// Third-party imports
import { Effect } from 'effect';
import { glob } from 'glob';

// Internal imports
import { withLogChannel, WorkspaceFs } from '@texra-ai/harness';
import { EXCLUDED_DIRS } from '@texra/shared/constants/latexTiming';

// Local file imports
import { CHANNEL } from './constants';
import { GlobFailed } from './utils';

/**
 * Every `build/` directory under the session's workspace, relative to its
 * root. The workspace filesystem comes from context and is already rooted,
 * so this listing and {@link removeBuildDirectories} cannot name different
 * workspaces.
 */
export const findBuildDirectories = Effect.gen(function* () {
  const workspacePath = (yield* WorkspaceFs).root;
  if (!workspacePath) return [];

  const ignorePatterns = [...EXCLUDED_DIRS]
    .filter((dir) => dir !== 'build')
    .map((dir) => `**/${dir}/**`);

  // The trailing slash makes glob match directories only, so a plain file
  // named `build` is never listed for recursive removal; results still come
  // back without the slash. `posix` keeps them `/`-separated on Windows too,
  // the workspace-relative form every listing here uses.
  const pattern = '**/build/';
  const directories = yield* Effect.tryPromise({
    try: () =>
      glob(pattern, {
        cwd: workspacePath,
        ignore: ignorePatterns,
        posix: true,
      }),
    catch: (cause) => new GlobFailed({ pattern, cause }),
  });
  return directories.toSorted();
});

/**
 * Delete the listed workspace-relative directories. Returns the ones that
 * could not be removed, each already logged, so the caller can say so.
 */
export const removeBuildDirectories = Effect.fn(
  'housekeeping.removeBuildDirectories',
)(function* (directories: readonly string[]) {
  const workspaceFs = yield* WorkspaceFs;
  const removed = yield* Effect.forEach(
    directories,
    (dir) =>
      workspaceFs.remove(dir, { recursive: true, force: true }).pipe(
        Effect.tap(() =>
          Effect.logDebug(`Removed build directory: ${dir}`).pipe(
            withLogChannel(CHANNEL),
          ),
        ),
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logError(`Error removing build directory ${dir}`).pipe(
            Effect.annotateLogs({ data: error }),
            withLogChannel(CHANNEL),
            Effect.as(false),
          ),
        ),
      ),
    { concurrency: 8 },
  );
  return directories.filter((_, index) => !removed[index]);
});
