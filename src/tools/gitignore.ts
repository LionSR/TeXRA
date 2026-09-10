// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Deferred, Effect, Exit } from 'effect';
import ignore from 'ignore';

// Local imports - common
import { isFileNotFoundError } from '@common/errors';
import { hostPort } from '@common/hostPort';

// Local imports - utils
import { filterNotNull } from '@utils/core';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { toPosixPath } from '@utils/core/pathCore';
import { safeHomedir } from '@utils/system/platformPaths';

type GitignoreSource = {
  absolutePath: string;
  content: string;
};

type GitignoreMatcher = {
  ignores: (relativePath: string) => boolean;
  ignoreFiles: string[];
};

const EMPTY_GITIGNORE_MATCHER: GitignoreMatcher = {
  ignores: () => false,
  ignoreFiles: [],
};

/**
 * The shared load, or nothing when no load has succeeded yet. Callers that
 * arrive while a load is in flight await its outcome instead of starting a
 * second one; a failed load clears this so the next caller retries.
 */
let sharedLoad: Deferred.Deferred<GitignoreMatcher, unknown> | undefined;

const readGitignoreFile = (
  absolutePath: string,
  readContent: Effect.Effect<string, unknown>,
): Effect.Effect<GitignoreSource | null, unknown> =>
  readContent.pipe(
    Effect.map((content): GitignoreSource | null => ({
      absolutePath,
      content,
    })),
    // An absent policy file is the normal case; any other read failure is the
    // caller's to see.
    Effect.catch((error) =>
      isFileNotFoundError(error) ? Effect.succeed(null) : Effect.fail(error),
    ),
  );

const readWorkspaceGitignore = (
  relativePath: string,
): Effect.Effect<GitignoreSource | null, unknown> => {
  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    return Effect.succeed(null);
  }
  const normalized = relativePath.replace(/^\/+/, '');
  return readGitignoreFile(
    path.join(workspacePath, normalized),
    hostPort(() => WorkspaceFS.read(normalized)),
  );
};

const readGlobalGitignore = (): Effect.Effect<
  GitignoreSource | null,
  unknown
> => {
  const homeDirectory = safeHomedir();
  if (!homeDirectory) {
    return Effect.succeed(null);
  }
  const absolutePath = path.join(homeDirectory, '.gitignore_global');
  return readGitignoreFile(
    absolutePath,
    hostPort(() => AbsoluteFS.read(absolutePath)),
  );
};

const loadGitignoreMatcher = Effect.fn('loadGitignoreMatcher')(function* () {
  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    return EMPTY_GITIGNORE_MATCHER;
  }

  const sources = (yield* Effect.all(
    [
      readGlobalGitignore(),
      readWorkspaceGitignore('.gitignore_global'),
      readWorkspaceGitignore('.gitignore'),
    ],
    // The three policies were read together and fail fast, as Promise.all did.
    { concurrency: 'unbounded' },
  )).filter(filterNotNull);

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

export const getGitignoreMatcher = Effect.fn('getGitignoreMatcher')(
  function* (): Effect.fn.Return<GitignoreMatcher, unknown> {
    const inFlight = sharedLoad;
    if (inFlight) {
      return yield* Deferred.await(inFlight);
    }
    const deferred = Deferred.makeUnsafe<GitignoreMatcher, unknown>();
    sharedLoad = deferred;
    // The load completes even if the caller that started it is interrupted:
    // every other caller is waiting on this Deferred, and an interrupted
    // shared load would strand them.
    return yield* Effect.uninterruptible(
      loadGitignoreMatcher().pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isFailure(exit) && sharedLoad === deferred) {
              sharedLoad = undefined;
            }
            Deferred.doneUnsafe(deferred, exit);
          }),
        ),
      ),
    );
  },
);
