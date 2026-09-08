import { join } from 'node:path';

import { Effect } from 'effect';
import * as FileSystem from 'effect/FileSystem';

import { byString, normalizeFilePath } from '@utils/core';

import {
  passesFileFilters,
  prepareFileFilters,
  shouldVisitDirectory,
  type FileFilterConfig,
} from './fileListingRules';
import type { PlatformError } from 'effect/PlatformError';

export interface WorkspaceFileListingOptions {
  root: string;
  config: FileFilterConfig;
}

/**
 * Walk `root` and collect the workspace-relative paths its filters admit.
 *
 * `FileSystem.readDirectory` returns names only, so each entry costs a `stat`
 * to classify — the repo's `FileSystemProvider.readDirectory` reads the type
 * off the `withFileTypes` dirent for free and pays a `stat` only for symlinks.
 * A dangling symlink `stat`s as `NotFound`; it is skipped, matching the old
 * walk, which typed it `SymbolicLink | Unknown` and matched neither branch.
 */
export function listWorkspaceFiles(
  options: WorkspaceFileListingOptions,
): Effect.Effect<string[], PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const filters = prepareFileFilters(options.config);
    const results: string[] = [];

    const visit = (
      directory: string,
      relativeDirectory: string,
    ): Effect.Effect<void, PlatformError> =>
      Effect.gen(function* () {
        const names = yield* fileSystem.readDirectory(directory);

        for (const name of names) {
          const relativePath = normalizeFilePath(
            relativeDirectory ? `${relativeDirectory}/${name}` : name,
          );
          const absolutePath = join(directory, name);

          const info = yield* fileSystem.stat(absolutePath).pipe(
            Effect.map((value) => value.type),
            Effect.catchTag('PlatformError', (error) =>
              error.reason._tag === 'NotFound'
                ? Effect.succeed<FileSystem.File.Type | undefined>(undefined)
                : Effect.fail(error),
            ),
          );

          if (info === 'Directory') {
            if (shouldVisitDirectory(relativePath, filters)) {
              yield* visit(absolutePath, relativePath);
            }
            continue;
          }

          if (info === 'File' && passesFileFilters(relativePath, filters)) {
            results.push(relativePath);
          }
        }
      });

    yield* visit(options.root, '');
    return results.sort(byString);
  });
}
