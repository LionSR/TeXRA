// Third-party imports
import { Effect, FileSystem, PlatformError } from 'effect';

// Common imports
import { isNotADirectoryError } from '@common/errors';

/**
 * The failures an existence probe reads as absent: the path is not there
 * (`ENOENT`), or a parent component is a file rather than a directory
 * (`ENOTDIR`), which `FileSystem.exists` reports as `BadResource`. Every other
 * failure propagates.
 */
export const absentReason = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === 'NotFound' ||
  (error.reason._tag === 'BadResource' &&
    isNotADirectoryError(error.reason.cause));

/**
 * lstat's half of both probes below (`FileSystem` has no lstat): a path
 * `readLink` names is a link, dangling or circular alike. Any failure means
 * not a link, or not there at all, and the caller's follow-up probe decides.
 */
const isLink = (fs: FileSystem.FileSystem, target: string) =>
  fs.readLink(target).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );

/**
 * Whether `target` names a filesystem entry, with lstat semantics: a path
 * names an entry whenever lstat resolves it, whether or not the link can be
 * followed.
 *
 * `FileSystem.exists` asks the stricter `access(2)` question — does the path
 * *resolve* — so a dangling symlink reads as absent there, and a caller that
 * branches on that answer (a read it skips, a "not seen before" write) would
 * then act on a path that does name an entry.
 *
 * {@link isLink} answers lstat's half and the access probe answers everything
 * else: `ENOTDIR` reads as absent, and any other failure propagates.
 */
export const entryExists = (
  fs: FileSystem.FileSystem,
  target: string,
): Effect.Effect<boolean, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    if (yield* isLink(fs, target)) return true;
    return yield* fs
      .exists(target)
      .pipe(Effect.catchIf(absentReason, () => Effect.succeed(false)));
  });

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
