// Node imports
import { join } from 'node:path';
import { normalizeFilePath } from '@texra-ai/worldline/schemas';
import {
  meansAbsent,
  readDirectoryTypedTolerant,
} from '@texra-ai/worldline/node';

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
  configs: readonly FileFilterConfig[];
  /**
   * What the walk does with a symbolic link. A listing a person picks from
   * follows links, since a linked folder of shared sources is theirs to
   * pick. A walk whose results are rewritten or deleted skips them, so it
   * never reaches through a link out of the tree it was given.
   */
  links: 'follow' | 'skip';
}

/** One config's share of a walk, relative to the root and sorted. */
interface WorkspaceListing {
  /** The files the config's filters admit. */
  readonly files: string[];
  /** The directories the config entered. */
  readonly directories: string[];
}

/**
 * For each config, the paths under `root` its filters admit. One walk serves
 * every config: a directory is entered when any config still visits it, and
 * only those configs judge what is below. A hidden entry, and a directory
 * the config excludes (by name, case-insensitively), is never entered.
 * Each entry's type comes with the directory listing (`readdir` dirents,
 * read from Node directly: `FileSystem` has no typed listing). A followed
 * symlink costs a `stat`, through the `FileSystem` service: a link to a
 * directory is visited, a link to a file is listed, and a dangling,
 * circular, or unreadable link is skipped. A directory that vanished
 * between its parent's listing and its own is skipped; a file that did is
 * still listed, since nothing probes it.
 */
export const listWorkspaceFiles = Effect.fn(
  'workspaceFileListing.listWorkspaceFiles',
)(function* (options: WorkspaceFileListingOptions) {
  const fs = yield* FileSystem.FileSystem;
  const filters = options.configs.map(prepareFileFilters);
  const results = filters.map((): WorkspaceListing => ({
    files: [],
    directories: [],
  }));

  // A link's target type, or undefined when links are skipped or this one
  // does not resolve. Absent (`meansAbsent`: NotFound / ENOTDIR), the rest
  // of BadResource (`ELOOP`), and PermissionDenied skip the entry; any other
  // failure is real. glob.ts drops NotFound and BadResource the same way.
  const followLink = (absolutePath: string) =>
    options.links === 'skip'
      ? Effect.undefined
      : fs.stat(absolutePath).pipe(
          Effect.map((info) => info.type),
          Effect.catchIf(
            (error) =>
              meansAbsent(error) ||
              error.reason._tag === 'BadResource' ||
              error.reason._tag === 'PermissionDenied',
            () => Effect.undefined,
          ),
        );

  // `active` holds the indexes of the configs that visit `directory`.
  const visit = Effect.fn('visit')(function* (
    directory: string,
    relativeDirectory: string,
    active: readonly number[],
  ): Effect.fn.Return<void, PlatformError.PlatformError, Path.Path> {
    const entries = yield* readDirectoryTypedTolerant(directory);

    // Results are sorted at the end, so entries are handled concurrently.
    yield* Effect.forEach(
      entries,
      Effect.fnUntraced(function* ([name, entryType]) {
        const relativePath = normalizeFilePath(
          relativeDirectory ? `${relativeDirectory}/${name}` : name,
        );
        const absolutePath = join(directory, name);
        const type =
          entryType === 'SymbolicLink'
            ? yield* followLink(absolutePath)
            : entryType;

        if (type === 'Directory') {
          const visiting = active.filter((i) =>
            shouldVisitDirectory(relativePath, filters[i]),
          );
          for (const i of visiting) results[i].directories.push(relativePath);
          if (visiting.length > 0) {
            yield* visit(absolutePath, relativePath, visiting).pipe(
              Effect.catchIf(meansAbsent, () => Effect.void),
            );
          }
        } else if (type === 'File') {
          for (const i of active)
            if (passesFileFilters(relativePath, filters[i]))
              results[i].files.push(relativePath);
        }
      }),
      { concurrency: 8, discard: true },
    );
  });

  yield* visit(
    options.root,
    '',
    filters.map((_, i) => i),
  );
  const sorted = (paths: readonly string[]) =>
    paths.toSorted((a, b) => a.localeCompare(b));
  return results.map(({ files, directories }): WorkspaceListing => ({
    files: sorted(files),
    directories: sorted(directories),
  }));
});
