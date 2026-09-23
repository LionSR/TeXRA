// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Data, Effect, FileSystem } from 'effect';
import { globIterate } from 'glob';

// Local imports
import { withLogChannel } from '@logger/effectLog';
import { createLog } from '@logger/logUtils';
import { relativeToRoot } from '@platform/defaults/nodeWorkspace';
import type { FileOpResult } from '@shared/schemas';
import { type RootedFileSystem } from '@utils/files/rootedFileSystem';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { normalizeFilePath } from '@utils/core';

import { CHANNEL } from './constants';

const log = createLog(CHANNEL);

/**
 * Every housekeeping failure reaches the host as the same result shape: the
 * operation is logged at the shared channel with the error attached, and the
 * caller sees `{status: 'error'}` instead of a rejection.
 */
export const asErrorResult = (operation: string) => (error: unknown) =>
  Effect.logError(`${operation} failed`).pipe(
    Effect.annotateLogs({ data: error }),
    withLogChannel(CHANNEL),
    Effect.as<FileOpResult>({ status: 'error', error: toErrorMessage(error) }),
  );

/**
 * A workspace listing that did not complete. The `glob` package rejects, and
 * a housekeeping command reports that as an error result rather than as a
 * defect, so the rejection is typed here instead of caught raw.
 */
export class GlobFailed extends Data.TaggedError('GlobFailed')<{
  readonly pattern: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Failed to list ${this.pattern}: ${String(this.cause)}`;
  }
}

/**
 * The filesystem a housekeeping path is handled through, with the path in
 * absolute form. The extension's picker keeps a selection outside the
 * workspace as an absolute path, and this passes such paths through whole:
 * every path of an external selection —
 * its sources, the `History/` or `Diffs/` folder beside it, the artifacts
 * swept there — is absolute and goes through the process `FileSystem` at its
 * own location. Every other path goes through the confined workspace view,
 * which is never loosened: a relative path as written, and an absolute one as
 * the workspace-relative path the symlink-aware `relativeToRoot` computes for
 * it — so a selection made through a symlinked directory whose target is
 * inside the workspace resolves, and the one computation that decides the
 * side is also the path handed to that side. Deciding per path also covers a
 * multi-file pack that copies an external output file into the workspace
 * folder beside its main input.
 */
export const filesystemFor = Effect.fn('housekeeping.filesystemFor')(function* (
  workspaceFs: RootedFileSystem,
  target: string,
) {
  let workspacePath: string | undefined = target;
  if (path.isAbsolute(target)) {
    workspacePath =
      workspaceFs.root === undefined
        ? undefined
        : relativeToRoot(workspaceFs.root, target);
  }
  if (workspacePath === undefined) {
    const fs: FileSystem.FileSystem = yield* FileSystem.FileSystem;
    return { fs, absolutePath: target };
  }
  const fs: FileSystem.FileSystem = workspaceFs;
  return { fs, absolutePath: yield* workspaceFs.resolve(workspacePath) };
});

/**
 * Produce an ISO-8601 timestamp stripped of separators, suitable for use in
 * a file or folder name (e.g. `20260422T003541`). Second-level granularity.
 */
export function generateTimestamp(): string {
  return new Date().toISOString().replaceAll(/[-:]/g, '').split('.')[0];
}

/**
 * Matching workspace files, as paths relative to `workspaceRoot` — the root
 * of the caller's `WorkspaceFs`, passed in rather than read from an ambient
 * store, so a listing and the deletions it feeds name the same workspace.
 */
async function* findFilesFromPatterns(
  workspaceRoot: string,
  inputDir: string,
  patterns: string[],
  extensions: string[],
): AsyncGenerator<string, void, void> {
  log.debug(
    `Finding files in ${inputDir} using patterns ${patterns} and extensions ${extensions}`,
  );

  // `resolve`, not `join`: an inputDir that is already absolute names the
  // directory it says, while a workspace-relative one is taken from the
  // workspace root. Joining an absolute path onto the root duplicated the
  // prefix and found nothing.
  const searchDirs = [path.resolve(workspaceRoot, inputDir)];
  if (!inputDir.includes('build')) {
    searchDirs.push(path.resolve(workspaceRoot, inputDir, 'build'));
  }

  for (const pattern of patterns) {
    for (const ext of extensions) {
      const isGlob = ext.includes('*');
      for (const dir of searchDirs) {
        let foundExactMatch = false;
        for await (const match of globIterate(
          path.join(dir, `${pattern}${ext}`),
          { nodir: true },
        )) {
          const relativePath = normalizeFilePath(
            relativeToRoot(workspaceRoot, match) ?? match,
          );
          log.debug(`Found file: ${relativePath}`);
          yield relativePath;

          if (!isGlob) {
            foundExactMatch = true;
            break;
          }
        }

        if (foundExactMatch) {
          // Exact extensions prefer the input directory; `build/` is only the
          // fallback when the corresponding root-level artifact is absent.
          break;
        }
      }
    }
  }
}

/**
 * The workspace-relative files matching `patterns` × `extensions` under
 * `inputDir`, deduplicated — overlapping patterns match the same path more
 * than once.
 */
export const collectFilesFromPatterns = Effect.fn(
  'housekeeping.collectFilesFromPatterns',
)(function* (
  workspaceRoot: string,
  inputDir: string,
  patterns: string[],
  extensions: string[],
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const files = new Set<string>();
      for await (const file of findFilesFromPatterns(
        workspaceRoot,
        inputDir,
        patterns,
        extensions,
      )) {
        files.add(file);
      }
      return files;
    },
    catch: (cause) =>
      new GlobFailed({ pattern: `${inputDir}: ${patterns.join(', ')}`, cause }),
  });
});
