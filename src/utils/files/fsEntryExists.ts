// Third-party imports
import { Effect, FileSystem, PlatformError } from 'effect';

// Common imports
import { isNotADirectoryError } from '@common/errors';

/**
 * The failures the facade's probe read as absent: the path is not there
 * (`ENOENT`), or a parent component is a file rather than a directory
 * (`ENOTDIR`), which `FileSystem.exists` reports as `BadResource`. Every other
 * failure propagated, and still does.
 */
export const absentReason = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === 'NotFound' ||
  (error.reason._tag === 'BadResource' &&
    isNotADirectoryError(error.reason.cause));

/**
 * Whether `target` names a filesystem entry — `BaseFS.exists` without the
 * facade.
 *
 * The facade probed with `stat`, whose provider is lstat-backed: a path names
 * an entry whenever lstat resolves it, whether or not the link can be
 * followed. `FileSystem.exists` asks the stricter `access(2)` question — does
 * the path *resolve* — so a dangling symlink reads as absent there where the
 * facade counted it present, and a caller that branches on that answer (a read
 * it skips, a "not seen before" write) then acts on a path that does name an
 * entry.
 *
 * `readLink` answers lstat's half directly — a path `readLink` names is a link
 * the facade counted, dangling or circular alike — and the access probe
 * answers everything else, exactly as the facade's own probe did: `ENOTDIR`
 * reads as absent, and any other failure propagates.
 */
export const entryExists = (
  fs: FileSystem.FileSystem,
  target: string,
): Effect.Effect<boolean, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const isLink = yield* fs.readLink(target).pipe(
      Effect.as(true),
      // Not a link, or not there at all: the access probe below decides.
      Effect.catch(() => Effect.succeed(false)),
    );
    if (isLink) return true;
    return yield* fs
      .exists(target)
      .pipe(Effect.catchIf(absentReason, () => Effect.succeed(false)));
  });

/**
 * The entry's own type at `target`, or `undefined` when nothing is there —
 * `BaseFS.stat().type` without the facade, whose provider was lstat-backed: a
 * link reports as itself rather than as what it points at, and a dangling one
 * still names an entry.
 *
 * `readLink` answers lstat's half, exactly as {@link entryExists} uses it, and
 * `stat` answers the rest. Only absence is recovered; every other failure
 * propagates, so an unreadable entry is never read as a missing one.
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
      Effect.catchIf(
        (error) => error.reason._tag === 'NotFound',
        () => Effect.succeed(undefined),
      ),
    );
  });
