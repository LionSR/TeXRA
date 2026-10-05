// Third-party imports
import { Effect, FileSystem, PlatformError } from 'effect';

// Common imports
import { isNotADirectoryError } from '@common/errors';

/**
 * The failures an existence probe reads as absent: the path is not there
 * (`ENOENT`), or a parent component is a file rather than a directory
 * (`ENOTDIR`), which the Node filesystem reports as `BadResource`. Every
 * other failure propagates.
 */
export const absentReason = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === 'NotFound' ||
  (error.reason._tag === 'BadResource' &&
    isNotADirectoryError(error.reason.cause));

/**
 * The entry's own type at `target`, or `undefined` when nothing is there, with
 * lstat semantics: a link reports as itself rather than as what it points at,
 * and a dangling or circular one still names an entry.
 *
 * `readLink` answers lstat's half directly — a path `readLink` names is a
 * link — and `stat` answers the rest. Only absence ({@link absentReason}) is
 * recovered; every other failure propagates, so an unreadable entry is never
 * read as a missing one.
 *
 * The caller passes the filesystem it probes with, so a rooted view answers
 * for the paths inside its root and the process filesystem answers for the
 * rest.
 */
export const entryTypeIn = (
  fs: FileSystem.FileSystem,
  target: string,
): Effect.Effect<
  FileSystem.File.Type | undefined,
  PlatformError.PlatformError
> =>
  Effect.gen(function* () {
    const isLink = yield* fs.readLink(target).pipe(
      Effect.as(true),
      // Not a link, or not there at all: the stat below decides.
      Effect.catch(() => Effect.succeed(false)),
    );
    if (isLink) return 'SymbolicLink';
    return yield* fs.stat(target).pipe(
      Effect.map((info) => info.type),
      Effect.catchIf(absentReason, () => Effect.succeed(undefined)),
    );
  });

/**
 * Whether `target` names a filesystem entry, with {@link entryTypeIn}'s lstat
 * semantics. `FileSystem.exists` asks the stricter `access(2)` question —
 * does the path *resolve* — so a dangling symlink reads as absent there, and
 * a caller that branches on that answer (a read it skips, a "not seen before"
 * write) would then act on a path that does name an entry.
 */
export const entryExists = (
  fs: FileSystem.FileSystem,
  target: string,
): Effect.Effect<boolean, PlatformError.PlatformError> =>
  Effect.map(entryTypeIn(fs, target), (type) => type !== undefined);
