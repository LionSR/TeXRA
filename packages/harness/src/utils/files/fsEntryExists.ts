// Third-party imports
import { Effect, FileSystem, PlatformError } from 'effect';

// Common imports
import { isNotADirectoryError } from '@common/errors';

/**
 * The failures an existence probe reads as absent: the path is not there
 * (`ENOENT`), or a parent component is a file rather than a directory
 * (`ENOTDIR`), which the platform reports as `BadResource`. Every other
 * failure propagates.
 */
export const absentReason = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === 'NotFound' ||
  (error.reason._tag === 'BadResource' &&
    isNotADirectoryError(error.reason.cause));

/**
 * lstat's half of the probe below (`FileSystem` has no lstat): a path
 * `readLink` names is a link, dangling or circular alike. Any failure means
 * not a link, or not there at all, and `stat` decides.
 */
const isLink = (fs: FileSystem.FileSystem, target: string) =>
  fs.readLink(target).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );

/**
 * The entry's own type at `target`, or `undefined` when nothing is there, with
 * lstat semantics: a link reports as itself rather than as what it points at,
 * and a dangling one still names an entry.
 *
 * {@link isLink} answers lstat's half and `stat` answers the rest. Only
 * absence ({@link absentReason}, `ENOTDIR` included) is recovered; every other
 * failure propagates, so an unreadable entry is never read as a missing one.
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
    if (yield* isLink(fs, target)) return 'SymbolicLink';
    return yield* fs.stat(target).pipe(
      Effect.map((info) => info.type),
      Effect.catchIf(absentReason, () => Effect.succeed(undefined)),
    );
  });

/**
 * Whether `target` names a filesystem entry, with {@link entryTypeIn}'s lstat
 * semantics: a dangling symlink names one, where `FileSystem.exists` (which
 * asks whether the path *resolves*) reads it as absent.
 */
export const entryExists = (
  fs: FileSystem.FileSystem,
  target: string,
): Effect.Effect<boolean, PlatformError.PlatformError> =>
  Effect.map(entryTypeIn(fs, target), (type) => type !== undefined);
