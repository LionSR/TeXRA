// Node imports
import { join } from 'node:path';
import { normalizeFilePath } from '@texra-ai/harness/schemas';
import {
  absentReason,
  readDirectoryTypedTolerant,
} from '@texra-ai/harness/node';

// Third-party imports
import { Effect, FileSystem, type Path, type PlatformError } from 'effect';

// Local imports
import {
  passesFileFilters,
  prepareFileFilters,
  shouldVisitDirectory,
  type FileFilterConfig,
} from '@texra/common/files/fileListingRules';

interface WorkspaceFileListingOptions {
  root: string;
  config: FileFilterConfig;
}

/**
 * The workspace-relative paths under `root` the filters admit, sorted.
 * Each entry's type comes with the directory listing (`readdir` dirents,
 * read from Node directly: `FileSystem` has no typed listing), so only a
 * symlink costs a `stat`, through the `FileSystem` service, which follows
 * it: a link to a directory is visited, a link to a file is listed, and a
 * dangling, circular, or unreadable link is skipped. A directory that
 * vanished between its parent's listing and its own is skipped; a file
 * that did is still listed, since nothing probes it.
 */
export const listWorkspaceFiles = Effect.fn(
  'workspaceFileListing.listWorkspaceFiles',
)(function* (options: WorkspaceFileListingOptions) {
  const fs = yield* FileSystem.FileSystem;
  const filters = prepareFileFilters(options.config);
  const results: string[] = [];

  // A link's target type, or undefined when it does not resolve. Absent
  // (`absentReason`: NotFound / ENOTDIR), the rest of BadResource (`ELOOP`),
  // and PermissionDenied skip the entry; any other failure is real. glob.ts
  // drops NotFound and BadResource the same way.
  const followLink = (absolutePath: string) =>
    fs.stat(absolutePath).pipe(
      Effect.map((info) => info.type),
      Effect.catchIf(
        (error) =>
          absentReason(error) ||
          error.reason._tag === 'BadResource' ||
          error.reason._tag === 'PermissionDenied',
        () => Effect.succeed(undefined),
      ),
    );

  function visit(
    directory: string,
    relativeDirectory: string,
  ): Effect.Effect<void, PlatformError.PlatformError, Path.Path> {
    return Effect.gen(function* () {
      const entries = yield* readDirectoryTypedTolerant(directory);

      // Results are sorted at the end, so entries are handled concurrently.
      yield* Effect.forEach(
        entries,
        ([name, entryType]) =>
          Effect.gen(function* () {
            const relativePath = normalizeFilePath(
              relativeDirectory ? `${relativeDirectory}/${name}` : name,
            );
            const absolutePath = join(directory, name);
            const type =
              entryType === 'SymbolicLink'
                ? yield* followLink(absolutePath)
                : entryType;

            if (type === 'Directory') {
              if (shouldVisitDirectory(relativePath, filters)) {
                yield* visit(absolutePath, relativePath).pipe(
                  Effect.catchIf(absentReason, () => Effect.void),
                );
              }
            } else if (
              type === 'File' &&
              passesFileFilters(relativePath, filters)
            ) {
              results.push(relativePath);
            }
          }),
        { concurrency: 8, discard: true },
      );
    });
  }

  yield* visit(options.root, '');
  return results.sort((a, b) => a.localeCompare(b));
});
