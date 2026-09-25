// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Data, Effect, FileSystem, type PlatformError } from 'effect';

// Local imports
import { withLogChannel } from '@logger/effectLog';
import { relativeToRoot } from '@platform/defaults/nodeWorkspace';
import type { FileOpResult } from '@shared/schemas';
import { type RootedFileSystem } from '@utils/files/rootedFileSystem';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { normalizeFilePath } from '@utils/core';

import { CHANNEL } from './constants';

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
 * The workspace-relative files named `pattern` + `extension` under
 * `inputDir` (then its `build/`), deduplicated: overlapping patterns match the
 * same path more than once. `workspaceRoot` is the root of the caller's
 * `WorkspaceFs`, passed in rather than read from an ambient store, so a
 * listing and the deletions it feeds name the same workspace.
 *
 * Paths are built and compared as plain strings, never globbed, so a path
 * holding glob metacharacters (`[`, `{`, `?`, a Windows backslash) names
 * itself. An exact extension stats `pattern + extension` directly, so it
 * follows the filesystem's own case rules. An extension ending in `*` matches
 * by prefix over a directory listing, case-insensitively where the platform
 * filesystem usually is (macOS, Windows).
 */
export const collectFilesFromPatterns = Effect.fn(
  'housekeeping.collectFilesFromPatterns',
)(function* (
  workspaceRoot: string,
  inputDir: string,
  patterns: string[],
  extensions: string[],
) {
  yield* Effect.logDebug(
    `Finding files in ${inputDir} using patterns ${patterns} and extensions ${extensions}`,
  ).pipe(withLogChannel(CHANNEL));
  const fs = yield* FileSystem.FileSystem;
  const foldCase =
    process.platform === 'win32' || process.platform === 'darwin'
      ? (name: string) => name.toLowerCase()
      : (name: string) => name;

  // `resolve`, not `join`: an inputDir that is already absolute names the
  // directory it says, while a workspace-relative one is taken from the
  // workspace root. Joining an absolute path onto the root duplicated the
  // prefix and found nothing.
  const searchDirs = [path.resolve(workspaceRoot, inputDir)];
  if (!inputDir.includes('build')) {
    searchDirs.push(path.resolve(workspaceRoot, inputDir, 'build'));
  }

  // A path that does not exist, or runs through something that is not a
  // directory (a regular file named `build`: ENOTDIR maps to BadResource),
  // holds no artifacts. Any other failure is real.
  const absentAs =
    <A>(value: A) =>
    <R>(effect: Effect.Effect<A, PlatformError.PlatformError, R>) =>
      effect.pipe(
        Effect.catch((error) =>
          error.reason._tag === 'NotFound' ||
          error.reason._tag === 'BadResource'
            ? Effect.succeed(value)
            : Effect.fail(error),
        ),
      );

  const files = new Set<string>();
  const listings = new Map<string, ReadonlyArray<string>>();
  const namesIn = Effect.fnUntraced(function* (dir: string) {
    const cached = listings.get(dir);
    if (cached !== undefined) return cached;
    const names = yield* fs
      .readDirectory(dir)
      .pipe(absentAs<ReadonlyArray<string>>([]));
    listings.set(dir, names);
    return names;
  });
  // A name removed between the listing and this stat is gone, not an error.
  const isFile = (match: string) =>
    fs.stat(match).pipe(
      Effect.map((info) => info.type !== 'Directory'),
      absentAs(false),
    );
  const record = Effect.fnUntraced(function* (match: string) {
    const relativePath = normalizeFilePath(
      relativeToRoot(workspaceRoot, match) ?? match,
    );
    yield* Effect.logDebug(`Found file: ${relativePath}`).pipe(
      withLogChannel(CHANNEL),
    );
    files.add(relativePath);
  });

  for (const pattern of patterns) {
    for (const ext of extensions) {
      if (!ext.endsWith('*')) {
        // Exact extensions prefer the input directory; `build/` is only the
        // fallback when the corresponding root-level artifact is absent.
        for (const dir of searchDirs) {
          const match = path.join(dir, pattern + ext);
          if (yield* isFile(match)) {
            yield* record(match);
            break;
          }
        }
        continue;
      }
      const wanted = foldCase(pattern + ext.slice(0, -1));
      for (const dir of searchDirs) {
        for (const name of yield* namesIn(dir)) {
          if (!foldCase(name).startsWith(wanted)) continue;
          const match = path.join(dir, name);
          if (yield* isFile(match)) yield* record(match);
        }
      }
    }
  }
  return files;
});
