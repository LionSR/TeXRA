// Third-party imports
import { Effect, FileSystem, PlatformError, Predicate, Schedule } from 'effect';

// Common imports
import { isNotADirectoryError } from '@common/errors/errorPredicates';

/**
 * Whether a failure means nothing is at the path: it is not there
 * (`ENOENT`), or a parent component is a file rather than a directory
 * (`ENOTDIR`), the two cases Node's own `statSync(path, { throwIfNoEntry:
 * false })` reads as no entry. It answers for the standard library's
 * `PlatformError`, which reports `ENOTDIR` as `BadResource`, and for a bare
 * Node error. Every other failure (`EACCES`, `ELOOP`, `EISDIR`, ...) is not
 * absence and propagates from a caller that recovers only this.
 */
export const absentReason = (error: unknown): boolean =>
  PlatformError.isPlatformError(error)
    ? error.reason._tag === 'NotFound' ||
      (error.reason._tag === 'BadResource' &&
        isNotADirectoryError(error.reason.cause))
    : isNotADirectoryError(error) ||
      (Predicate.hasProperty(error, 'code') && error.code === 'ENOENT');

/**
 * Restart schedule for an `fs.watch` stream: up to 5 retries, 1 s doubling,
 * and only for `Unknown` platform errors (a missing or denied directory will
 * not fix itself, so those end the stream).
 */
export const fileWatchRetrySchedule = Schedule.exponential('1 second').pipe(
  Schedule.upTo({ times: 5 }),
  Schedule.while(
    ({ input }: { readonly input: PlatformError.PlatformError }) =>
      input.reason._tag === 'Unknown',
  ),
);

/**
 * The entry's own type at `target`, or `undefined` when nothing is there, with
 * lstat semantics: a link reports as itself rather than as what it points at,
 * and a dangling one still names an entry.
 *
 * One `lstat`, so a dangling or circular link is still an entry. Only
 * absence ({@link absentReason}, `ENOTDIR` included) is recovered; every other
 * failure propagates, so an unreadable entry is never read as a missing one.
 *
 * The caller passes the filesystem it probes with, so a rooted view answers
 * for the paths inside its root and the process filesystem answers for the
 * rest.
 */
export const entryTypeIn = Effect.fn('fsEntryExists.entryTypeIn')(function* (
  fs: FileSystem.FileSystem,
  target: string,
): Effect.fn.Return<
  FileSystem.File.Type | undefined,
  PlatformError.PlatformError
> {
  return yield* fs.lstat(target).pipe(
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

/**
 * `FileSystem.exists` with a path whose parent is not a directory (`ENOTDIR`)
 * counted as absent alongside `ENOENT`; the standard library reports that
 * case as `BadResource`. {@link absentReason} names ENOTDIR specifically, so
 * an operational failure (`ELOOP`, `EACCES`) still propagates instead of
 * reading as "absent".
 *
 * This probe follows links, so a dangling symlink reads as absent (ENOENT)
 * while a circular one raises ELOOP and propagates, unlike the lstat-backed
 * {@link entryExists}. A
 * caller asking whether a dependency, figure, bibliography or input *file* is
 * unusable wants the follow; a caller asking whether the path names an entry
 * wants `entryExists`.
 *
 * The caller passes the filesystem it probes with, so a rooted view answers
 * for the paths inside its root and the process filesystem answers for the
 * rest.
 */
export const pathExists = (
  fs: FileSystem.FileSystem,
  target: string,
): Effect.Effect<boolean, PlatformError.PlatformError> =>
  fs
    .exists(target)
    .pipe(Effect.catchIf(absentReason, () => Effect.succeed(false)));
