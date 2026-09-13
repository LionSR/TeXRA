// Third-party imports
import { Effect } from 'effect';
import { glob } from 'glob';

// Internal imports
import { withLogChannel, withLogData } from '@logger/effectLog';
import { WorkspaceFs } from '@platform/rootedFs';
import { EXCLUDED_DIRS } from '@shared/constants/latexTiming';

// Local file imports
import { CHANNEL } from './constants';
import { GlobFailed } from './utils';

/**
 * Delete every `build/` directory under the session's workspace. The
 * workspace filesystem comes from context and is already rooted, so the
 * listing and the deletions cannot name different workspaces.
 */
export const runCleanBuild = Effect.gen(function* () {
  yield* Effect.logDebug('Starting build directory cleanup').pipe(
    withLogChannel(CHANNEL),
  );

  const workspaceFs = yield* WorkspaceFs;
  const workspacePath = workspaceFs.root;
  if (!workspacePath) {
    return;
  }

  const ignorePatterns = [...EXCLUDED_DIRS]
    .filter((dir) => dir !== 'build')
    .map((dir) => `**/${dir}/**`);

  const directories = yield* Effect.tryPromise({
    try: () =>
      glob('**/build', {
        cwd: workspacePath,
        ignore: ignorePatterns,
        nodir: false,
      }),
    catch: (cause) => new GlobFailed({ pattern: '**/build', cause }),
  });

  for (const dir of directories) {
    yield* workspaceFs.remove(dir, { recursive: true, force: true }).pipe(
      Effect.tap(() =>
        Effect.logDebug(`Removed build directory: ${dir}`).pipe(
          withLogChannel(CHANNEL),
        ),
      ),
      Effect.catch((error) =>
        Effect.logError(`Error removing build directory ${dir}`).pipe(
          withLogData(error),
          withLogChannel(CHANNEL),
        ),
      ),
    );
  }

  yield* Effect.logInfo('Build directories cleaned').pipe(
    withLogChannel(CHANNEL),
  );
});
