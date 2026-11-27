/** The LaTeX auxiliary files a compile of one file leaves behind. */
// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Option, type PlatformError } from 'effect';

// Local imports
import { meansAbsent } from '@texra-ai/worldline/node';
import { withLogChannel } from '@texra-ai/worldline/plugins';

import { LATEX_BUILD_DIRECTORY } from '@texra/common/files/fileHandlingRules';
import { CHANNEL } from './constants';

/** The extensions a compile's auxiliary files carry after the source's
 *  stem; one ending in `*` matches by prefix. */
const AUX_EXTENSIONS = Object.freeze([
  '.bak*',
  '.pdf',
  '.aux',
  '.bbl',
  '.blg',
  '.fdb_latexmk',
  '.fls',
  '.log',
  '.out',
  '.synctex.gz',
  '.bib',
  '.nav',
  '.run.xml',
  '.snm',
  '.toc',
  '-blx.bib',
  'Notes.bib',
]);

/**
 * The absolute paths of the auxiliary files a compile of `filePath` wrote,
 * beside it or in its folder's `build/`: its stem (the whole name when it
 * has no extension) plus each of {@link AUX_EXTENSIONS}, deduplicated.
 *
 * Paths are built and compared as plain strings, never globbed, so a path
 * holding glob metacharacters (`[`, `{`, `?`, a Windows backslash) names
 * itself. An exact extension stats the name directly, so it follows the
 * filesystem's own case rules, and prefers the file's own folder: `build/`
 * is only the fallback when that artifact is absent there. An extension
 * ending in `*` matches by prefix over a directory listing,
 * case-insensitively where the platform filesystem usually is (macOS,
 * Windows).
 */
export const auxFilesOf = Effect.fn('housekeeping.auxFilesOf')(function* (
  filePath: string,
) {
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath));
  yield* Effect.logDebug(`Finding the auxiliary files of ${filePath}`).pipe(
    withLogChannel(CHANNEL),
  );
  const fs = yield* FileSystem.FileSystem;
  const foldCase =
    process.platform === 'win32' || process.platform === 'darwin'
      ? (name: string) => name.toLowerCase()
      : (name: string) => name;

  const searchDirs = [dir, path.join(dir, LATEX_BUILD_DIRECTORY)];

  // A path that does not exist, or runs through something that is not a
  // directory (a regular file named `build`: ENOTDIR maps to BadResource),
  // holds no artifacts. Any other failure is real.
  const absentAs =
    <A>(value: A) =>
    <R>(effect: Effect.Effect<A, PlatformError.PlatformError, R>) =>
      effect.pipe(Effect.catchIf(meansAbsent, () => Effect.succeed(value)));

  // Each directory is listed once, up front, for the prefix extensions.
  const listings = new Map(
    yield* Effect.forEach(
      searchDirs,
      (searchDir) =>
        fs.readDirectory(searchDir).pipe(
          absentAs<ReadonlyArray<string>>([]),
          Effect.map((names) => [searchDir, names] as const),
        ),
      { concurrency: 'unbounded' },
    ),
  );
  // A name removed between the listing and this stat is gone, not an error.
  const isFile = (match: string) =>
    fs.stat(match).pipe(
      Effect.map((info) => info.type !== 'Directory'),
      absentAs(false),
    );

  // Every extension is probed together; the matches are recorded in
  // extension, then listing order.
  const matches = yield* Effect.forEach(
    AUX_EXTENSIONS,
    Effect.fnUntraced(function* (ext) {
      if (!ext.endsWith('*')) {
        return Option.toArray(
          yield* Effect.findFirst(
            searchDirs.map((searchDir) => path.join(searchDir, stem + ext)),
            isFile,
          ),
        );
      }
      const wanted = foldCase(stem + ext.slice(0, -1));
      const candidates = searchDirs.flatMap((searchDir) =>
        (listings.get(searchDir) ?? [])
          .filter((name) => foldCase(name).startsWith(wanted))
          .map((name) => path.join(searchDir, name)),
      );
      return yield* Effect.filter(candidates, isFile, { concurrency: 16 });
    }),
    { concurrency: 8 },
  );
  const files = new Set(matches.flat());
  for (const file of files) {
    yield* Effect.logDebug(`Found file: ${file}`).pipe(withLogChannel(CHANNEL));
  }
  return files;
});
