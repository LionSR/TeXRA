/** The files a housekeeping command cleans: the artifacts a pattern names. */
// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Option, type PlatformError } from 'effect';

// Local imports
import { meansAbsent, workspaceRelativePath } from '@texra-ai/worldline/node';
import { withLogChannel } from '@texra-ai/worldline/plugins';

import { LATEX_BUILD_DIRECTORY } from '@texra/common/files/fileHandlingRules';
import { CHANNEL } from './constants';

/**
 * The LaTeX artifacts of a base name: the files named `pattern` + `extension`
 * under `inputDir` (then its `build/`), relative to `workspaceRoot`,
 * deduplicated: overlapping patterns match the same path more than once.
 * Clean Build and packing pass the root of their `WorkspaceFs`, passed in
 * rather than read from an ambient store, so a listing and the deletions it
 * feeds name the same workspace; a preview's cleanup passes its file's own
 * directory.
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
  patterns: readonly string[],
  extensions: readonly string[],
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
  // An inputDir that names the build directory has no build directory of its
  // own. Its last segment is compared whole: `rebuild` and `build-notes` are
  // ordinary folders, and so is a workspace that is itself called `build`.
  if (path.basename(inputDir).toLowerCase() !== LATEX_BUILD_DIRECTORY) {
    searchDirs.push(path.join(searchDirs[0], LATEX_BUILD_DIRECTORY));
  }

  // A path that does not exist, or runs through something that is not a
  // directory (a regular file named `build`: ENOTDIR maps to BadResource),
  // holds no artifacts. Any other failure is real.
  const absentAs =
    <A>(value: A) =>
    <R>(effect: Effect.Effect<A, PlatformError.PlatformError, R>) =>
      effect.pipe(Effect.catchIf(meansAbsent, () => Effect.succeed(value)));

  const files = new Set<string>();
  // Each directory is listed once, up front, when a prefix extension needs
  // the listing.
  const listings = new Map(
    extensions.some((ext) => ext.endsWith('*'))
      ? yield* Effect.forEach(
          searchDirs,
          (dir) =>
            fs.readDirectory(dir).pipe(
              absentAs<ReadonlyArray<string>>([]),
              Effect.map((names) => [dir, names] as const),
            ),
          { concurrency: 'unbounded' },
        )
      : [],
  );
  // A name removed between the listing and this stat is gone, not an error.
  const isFile = (match: string) =>
    fs.stat(match).pipe(
      Effect.map((info) => info.type !== 'Directory'),
      absentAs(false),
    );
  const record = Effect.fnUntraced(function* (match: string) {
    const relativePath = workspaceRelativePath(workspaceRoot, match);
    yield* Effect.logDebug(`Found file: ${relativePath}`).pipe(
      withLogChannel(CHANNEL),
    );
    files.add(relativePath);
  });

  // Every pattern and extension is probed together; the matches are
  // recorded in pattern, extension, then listing order.
  const matches = yield* Effect.forEach(
    patterns.flatMap((pattern) =>
      extensions.map((ext) => [pattern, ext] as const),
    ),
    Effect.fnUntraced(function* ([pattern, ext]) {
      if (!ext.endsWith('*')) {
        // Exact extensions prefer the input directory; `build/` is only the
        // fallback when the corresponding root-level artifact is absent.
        return Option.toArray(
          yield* Effect.findFirst(
            searchDirs.map((dir) => path.join(dir, pattern + ext)),
            isFile,
          ),
        );
      }
      const wanted = foldCase(pattern + ext.slice(0, -1));
      const candidates = searchDirs.flatMap((dir) =>
        (listings.get(dir) ?? [])
          .filter((name) => foldCase(name).startsWith(wanted))
          .map((name) => path.join(dir, name)),
      );
      return yield* Effect.filter(candidates, isFile, { concurrency: 16 });
    }),
    { concurrency: 8 },
  );
  yield* Effect.forEach(matches.flat(), record, { discard: true });
  return files;
});
