// Third-party imports
import { Effect } from 'effect';

// Internal imports
import { withLogChannel, WorkspaceFs } from '@texra-ai/harness/plugins';
import { getBasename } from '@texra-ai/harness/schemas';
import {
  FILE_HANDLING_RULES,
  LATEX_BUILD_DIRECTORY,
} from '@texra/common/files/fileHandlingRules';
import { removeBestEffort } from '@texra/common/files/removeBestEffort';
import { listWorkspaceFiles } from '@texra/common/files/workspaceFileListing';

// Local file imports
import { CHANNEL } from './constants';

/**
 * Every `build/` directory under the session's workspace, relative to its
 * root, its name compared case-insensitively like every managed directory.
 * The workspace filesystem comes from context and is already rooted, so
 * this listing and {@link removeBuildDirectories} cannot name different
 * workspaces. Only directories are listed, so a plain file named `build` is
 * never offered for recursive removal, and links are skipped, so the
 * removal never reaches through one.
 */
export const findBuildDirectories = Effect.gen(function* () {
  const workspaceRoot = (yield* WorkspaceFs).root;
  if (!workspaceRoot) return [];

  // A `build/` inside a package or environment tree is not this project's
  // LaTeX output, so those trees are not searched.
  const [{ directories }] = yield* listWorkspaceFiles({
    root: workspaceRoot,
    configs: [
      {
        include: [],
        excludeExtensions: [],
        excludeDirs:
          FILE_HANDLING_RULES.ignored.bulkOperationDirectories.filter(
            (dir) => dir !== LATEX_BUILD_DIRECTORY,
          ),
        excludeKeywords: [],
        excludeFiles: [],
      },
    ],
    links: 'skip',
  });
  return directories.filter(
    (dir) => getBasename(dir).toLowerCase() === LATEX_BUILD_DIRECTORY,
  );
});

/**
 * Delete the listed workspace-relative directories. Returns the ones that
 * could not be removed, each already logged, so the caller can say so.
 */
export const removeBuildDirectories = Effect.fn(
  'housekeeping.removeBuildDirectories',
)(function* (directories: readonly string[]) {
  const workspaceFs = yield* WorkspaceFs;
  const removed = new Set(
    yield* removeBestEffort(workspaceFs, directories, 'build directory', {
      recursive: true,
    }),
  );
  return directories.filter((dir) => !removed.has(dir));
}, withLogChannel(CHANNEL));
