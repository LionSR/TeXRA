// Node imports
import { join } from 'node:path';

// Third-party imports
import { Effect, FileSystem, type PlatformError } from 'effect';

// Local imports
import { byString, normalizeFilePath } from '@utils/core';
import { absentReason } from '@utils/files/fsEntryExists';

import {
  passesFileFilters,
  prepareFileFilters,
  shouldVisitDirectory,
  type FileFilterConfig,
} from './fileListingRules';

export interface WorkspaceFileListingOptions {
  root: string;
  config: FileFilterConfig;
}

/**
 * The workspace-relative paths under `root` the filters admit, sorted.
 * `FileSystem.readDirectory` returns names alone, so each entry's type is a
 * `stat` — which follows a symlink, matching the platform listing this
 * replaces: a link to a directory is visited, a link to a file is listed,
 * and a dangling, circular, or unreadable link, like an entry that vanished
 * between the listing and the probe, is skipped.
 */
export const listWorkspaceFiles = Effect.fn(
  'workspaceFileListing.listWorkspaceFiles',
)(function* (options: WorkspaceFileListingOptions) {
  const fs = yield* FileSystem.FileSystem;
  const filters = prepareFileFilters(options.config);
  const results: string[] = [];

  function visit(
    directory: string,
    relativeDirectory: string,
  ): Effect.Effect<void, PlatformError.PlatformError> {
    return Effect.gen(function* () {
      const entries = yield* fs.readDirectory(directory);

      for (const name of entries) {
        const relativePath = normalizeFilePath(
          relativeDirectory ? `${relativeDirectory}/${name}` : name,
        );
        const absolutePath = join(directory, name);
        const info = yield* fs.stat(absolutePath).pipe(
          // Absent (`absentReason`: NotFound / ENOTDIR), the rest of
          // BadResource (`ELOOP`), and PermissionDenied skip this entry;
          // any other failure is real. glob.ts drops NotFound and
          // BadResource the same way; the platform listing swallowed every
          // symlink-target stat error.
          Effect.catchIf(
            (error) =>
              absentReason(error) ||
              error.reason._tag === 'BadResource' ||
              error.reason._tag === 'PermissionDenied',
            () => Effect.succeed(undefined),
          ),
        );

        if (info?.type === 'Directory') {
          if (shouldVisitDirectory(relativePath, filters)) {
            yield* visit(absolutePath, relativePath);
          }
        } else if (
          info?.type === 'File' &&
          passesFileFilters(relativePath, filters)
        ) {
          results.push(relativePath);
        }
      }
    });
  }

  yield* visit(options.root, '');
  return results.sort(byString);
});
