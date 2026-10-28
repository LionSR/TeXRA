// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Predicate } from 'effect';
import ignore from 'ignore';

// Local imports - utils
import { toPosixPath } from '@utils/core/pathCore';
import { homeDirectory } from '@utils/system/platformPaths';

type GitignoreSource = {
  absolutePath: string;
  content: string;
};

/** A workspace's ignore policy: whether a workspace-relative path is
 *  ignored, and the policy files it was read from. */
export type GitignoreMatcher = {
  ignores: (relativePath: string) => boolean;
  ignoreFiles: string[];
};

const EMPTY_GITIGNORE_MATCHER: GitignoreMatcher = {
  ignores: () => false,
  ignoreFiles: [],
};

/**
 * Read one policy file by its absolute path, through the process filesystem:
 * the policies live in two different roots (the workspace and the user's
 * home), and each path here is already absolute.
 */
const readGitignoreFile = Effect.fn('readGitignoreFile')(function* (
  absolutePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(absolutePath).pipe(
    Effect.map((content): GitignoreSource | null => ({
      absolutePath,
      content: content.replaceAll('\r\n', '\n'),
    })),
    // An absent policy file is the normal case; any other read failure is the
    // caller's to see.
    Effect.catchIf(
      (error) => error.reason._tag === 'NotFound',
      () => Effect.succeed(null),
    ),
  );
});

/**
 * Build the ignore matcher for `workspacePath` from its ignore policy files.
 * The root is the caller's — the `WorkspaceFs` of the session the call works
 * on — rather than whichever roots the calling fiber carries, so a listing
 * and the policy that filters it name the same workspace. Read on every call:
 * a process serves several projects, and each call should see the policy as
 * it is on disk now.
 */
export const getGitignoreMatcher = Effect.fn('getGitignoreMatcher')(function* (
  workspacePath: string | undefined,
) {
  if (!workspacePath) {
    return EMPTY_GITIGNORE_MATCHER;
  }

  const home = yield* homeDirectory;
  const sources = (yield* Effect.all(
    [
      home
        ? readGitignoreFile(path.join(home, '.gitignore_global'))
        : Effect.succeed(null),
      readGitignoreFile(path.join(workspacePath, '.gitignore_global')),
      readGitignoreFile(path.join(workspacePath, '.gitignore')),
    ],
    // The three policies were read together and fail fast, as Promise.all did.
    { concurrency: 'unbounded' },
  )).filter(Predicate.isNotNull);

  if (sources.length === 0) {
    return EMPTY_GITIGNORE_MATCHER;
  }

  const ig = ignore();
  for (const source of sources) {
    ig.add(source.content);
  }

  return {
    ignores: (relativePath: string): boolean => {
      if (!relativePath || relativePath === '.') {
        return false;
      }
      const normalized = toPosixPath(relativePath);
      // Try plain path first; also try with trailing slash so that
      // directory-only rules (e.g. "dist/") match bare directory names
      // ("dist") the same way the old minimatch-based parser did.
      // Known deviation from strict git spec: a *file* named "dist" would
      // also be ignored by a "dist/" rule, because we cannot distinguish
      // files from directories without a stat call. The old parser had the
      // same behaviour (it expanded "dist/" → ["dist", "dist/**"]).
      return ig.ignores(normalized) || ig.ignores(normalized + '/');
    },
    ignoreFiles: sources.map((source) => source.absolutePath),
  };
});
