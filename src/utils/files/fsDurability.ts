/**
 * The filesystem primitives the repo must keep that the standard library's
 * `FileSystem` does not provide: crash-safe replace, a directory listing
 * carrying each entry's own (unfollowed) type, and exclusive or
 * symlink-dereferencing copies.
 *
 * These are the Effect form of what `baseFS.ts` reached `platform().fs` for.
 * Nothing here re-implements an operation `FileSystem` already has — an
 * append, for instance, is `fs.writeFile(path, data, { flag: 'a' })` and gets
 * no wrapper. The Node calls `FileSystem` cannot express (`lstat`,
 * `copyFile` with `COPYFILE_EXCL`, `cp` with `dereference`, and the
 * `write-file-atomic` package) classify their errno exactly as
 * `@effect/platform-node` does, so a consumer matches `SystemError` by
 * `reason._tag` either way.
 */

// Node imports
import { constants as fsConstants } from 'node:fs';
import * as nodeFs from 'node:fs/promises';

// Third-party imports
import { Effect, FileSystem, Path, PlatformError } from 'effect';

import writeFileAtomicLib from 'write-file-atomic';

import { isNotADirectoryError } from '@common/errors';
import { createLog } from '@logger/logUtils';
import { normalizeLineEndings } from '@utils/text/stringUtils';

const log = createLog('fsDurability');

const MODULE = 'FsDurability';

/**
 * `@effect/platform-node`'s errno classification, for the Node calls that have
 * no `FileSystem` equivalent: same codes, same normalized tags, so a consumer
 * matching `reason._tag` cannot tell which call produced the error.
 */
const SYSTEM_ERROR_TAGS: Readonly<
  Record<string, PlatformError.SystemErrorTag>
> = {
  ENOENT: 'NotFound',
  EACCES: 'PermissionDenied',
  EEXIST: 'AlreadyExists',
  EISDIR: 'BadResource',
  ENOTDIR: 'BadResource',
  ELOOP: 'BadResource',
  EBUSY: 'Busy',
};

function systemErrorFrom(
  method: string,
  target: string,
  cause: unknown,
): PlatformError.PlatformError {
  const error = cause as NodeJS.ErrnoException;
  return PlatformError.systemError({
    _tag: (error.code && SYSTEM_ERROR_TAGS[error.code]) || 'Unknown',
    module: MODULE,
    method,
    pathOrDescriptor: target,
    syscall: error.syscall,
    cause,
  });
}

/**
 * Crash-safe replace, delegated to `write-file-atomic` — the package the
 * `platform().fs` port uses — rather than re-derived: it stages under a name
 * unique across processes and threads, fsyncs, preserves an existing
 * target's mode and ownership, and resolves the target's real path so a
 * symlinked target is replaced where it points. For durable state a torn
 * file would make unreadable on resume; not for workspace files.
 */
export const writeFileAtomic = Effect.fn('fsDurability.writeFileAtomic')(
  function* (target: string, data: Uint8Array) {
    yield* Effect.tryPromise({
      try: () => writeFileAtomicLib(target, Buffer.from(data)),
      catch: (cause) => systemErrorFrom('writeFileAtomic', target, cause),
    });
  },
);

/** An `lstat` result or a `readdir` dirent as `FileSystem`'s entry type: a
 *  link is itself. Both carry the same predicate set, so one mapping serves
 *  the probed and the listed case. */
function entryTypeOf(entry: {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}): FileSystem.File.Type {
  if (entry.isSymbolicLink()) return 'SymbolicLink';
  if (entry.isFile()) return 'File';
  if (entry.isDirectory()) return 'Directory';
  if (entry.isBlockDevice()) return 'BlockDevice';
  if (entry.isCharacterDevice()) return 'CharacterDevice';
  if (entry.isFIFO()) return 'FIFO';
  if (entry.isSocket()) return 'Socket';
  return 'Unknown';
}

/**
 * `BaseFS.exists`'s reading of `FileSystem.exists`: a path whose parent is not
 * a directory (`ENOTDIR`) counted as absent alongside `ENOENT`, and the
 * standard library reports that case as `BadResource`. The predicate names
 * ENOTDIR specifically, so an operational failure (`ELOOP`, `EACCES`) still
 * propagates instead of reading as "absent".
 *
 * One reading differs, and it is deliberate: the facade's probe was
 * `lstat`-backed, so a dangling or circular symlink was present, while this
 * one follows the link and finds nothing there. A caller asking whether a
 * dependency, figure, bibliography or input *file* is unusable wants the
 * follow; a caller asking whether the path names an entry wants `readLink`
 * first and this as the fallback (see `existsAt` in `arxivProcessor.ts`).
 *
 * The caller passes the filesystem it probes with, so a rooted view answers
 * for the paths inside its root and the process filesystem answers for the
 * rest.
 */
export const pathExists = (
  fs: FileSystem.FileSystem,
  target: string,
): Effect.Effect<boolean, PlatformError.PlatformError> =>
  fs.exists(target).pipe(
    Effect.catchIf(
      (error) =>
        error.reason._tag === 'BadResource' &&
        isNotADirectoryError(error.reason.cause),
      () => Effect.succeed(false),
    ),
  );

/** The entry type of one path, `lstat`-backed: a link is itself, never what
 * it points at. `FileSystem.stat` follows links, so a containment check that
 * must see the link itself probes with this instead. */
export const entryTypeAt = Effect.fn('fsDurability.entryTypeAt')(function* (
  target: string,
) {
  const stats = yield* Effect.tryPromise({
    try: async () => nodeFs.lstat(target),
    catch: (cause) => systemErrorFrom('entryTypeAt', target, cause),
  });
  return entryTypeOf(stats);
});

/**
 * The entry type and size at `target`, `lstat` first and then `stat` when the
 * entry is a link — the reading the retired `platform().fs.stat` gave: a link
 * that resolves reports its target's type and size, and a dangling or
 * circular one reports the link itself rather than failing. `FileSystem.stat`
 * gives neither half: it follows the link and fails `NotFound` when the target
 * is gone, so a caller sizing a recorded path would lose the row.
 *
 * Absence is not recovered here; the caller decides what a missing path means,
 * as it did with the facade.
 */
export const entryMetadataAt = Effect.fn('fsDurability.entryMetadataAt')(
  function* (target: string) {
    const link = yield* Effect.tryPromise({
      try: () => nodeFs.lstat(target),
      catch: (cause) => systemErrorFrom('entryMetadataAt', target, cause),
    });
    const stats = link.isSymbolicLink()
      ? // A dangling or circular link has no target to describe, so the link's
        // own metadata stands in — the fallback the facade's provider made.
        yield* Effect.promise(() => nodeFs.stat(target).catch(() => link))
      : link;
    return { type: entryTypeOf(stats), size: stats.size };
  },
);

/**
 * The entries of `target` with the type of each, one `lstat` per entry: a
 * symlink reports as `SymbolicLink`, never as what it points at, so the
 * deletion and containment walkers that replace the old lstat-backed listing
 * can refuse to follow it. `FileSystem.stat` follows links and
 * `FileSystem.readDirectory` returns names alone, so neither carries this.
 */
export const readDirectoryTyped = Effect.fn('fsDurability.readDirectoryTyped')(
  function* (target: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = yield* fs.readDirectory(target);
    return yield* Effect.forEach(
      names,
      (name) => {
        const entry = path.join(target, name);
        return Effect.tryPromise({
          try: async () =>
            [name, entryTypeOf(await nodeFs.lstat(entry))] as const,
          catch: (cause) => systemErrorFrom('readDirectoryTyped', entry, cause),
        });
      },
      { concurrency: 'unbounded' },
    );
  },
);

/**
 * `readDirectoryTyped` for listings that must survive one bad entry: an entry
 * whose type cannot be read is dropped with a warning naming it and the
 * reason, instead of failing the whole directory.
 *
 * The listing comes from `readdir(..., { withFileTypes: true })`, so each
 * entry brings its own type and needs no second syscall. That is also what
 * keeps a directory that is readable but not searchable (`r--` on Unix)
 * listed: a probe would fail `EACCES` on every entry, and the tree would
 * render empty where the pre-migration listing showed it. Only an entry whose
 * dirent type the platform left `Unknown` is probed, and only that probe's
 * failure costs a row. The strict form stays with the containment and
 * deletion walkers, where a refused answer is the safe one.
 *
 * The Node call is the one `FileSystem` cannot make: `readDirectory` returns
 * names alone, and the pre-`readdir` answer is what carries the types.
 */
export const readDirectoryTypedTolerant = Effect.fn(
  'fsDurability.readDirectoryTypedTolerant',
)(function* (target: string) {
  const path = yield* Path.Path;
  const dirents = yield* Effect.tryPromise({
    try: () => nodeFs.readdir(target, { withFileTypes: true }),
    catch: (cause) =>
      systemErrorFrom('readDirectoryTypedTolerant', target, cause),
  });
  const rows = yield* Effect.forEach(
    dirents,
    (dirent) => {
      const known = entryTypeOf(dirent);
      if (known !== 'Unknown') {
        return Effect.succeed([dirent.name, known] as const);
      }
      const entry = path.join(target, dirent.name);
      return Effect.tryPromise({
        try: async () =>
          [dirent.name, entryTypeOf(await nodeFs.lstat(entry))] as const,
        catch: (cause) =>
          systemErrorFrom('readDirectoryTypedTolerant', entry, cause),
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            log.warn(
              `Skipping ${entry}: its entry type could not be read (${error.reason._tag}).`,
            );
            return undefined;
          }),
        ),
      );
    },
    { concurrency: 'unbounded' },
  );
  return rows.filter(
    (row): row is readonly [string, FileSystem.File.Type] => row !== undefined,
  );
});

/**
 * Copy one file to a destination that must not exist yet (`COPYFILE_EXCL`):
 * the existence check and the creation are one step, so of two concurrent
 * copies to the same name exactly one succeeds and the other fails with
 * `AlreadyExists`. `FileSystem.copy` silently skips an existing destination
 * and `FileSystem.copyFile` replaces it.
 */
export const copyFileExclusive = Effect.fn('fsDurability.copyFileExclusive')(
  function* (from: string, to: string) {
    yield* Effect.tryPromise({
      try: () => nodeFs.copyFile(from, to, fsConstants.COPYFILE_EXCL),
      catch: (cause) => systemErrorFrom('copyFileExclusive', to, cause),
    });
  },
);

/**
 * Copy a file or directory tree, replacing symlinks with the content they
 * point at, so the copy is self-contained. `FileSystem.copy` always
 * preserves links; a snapshot that must survive its source's deletion
 * cannot.
 */
export const copyDereferenced = Effect.fn('fsDurability.copyDereferenced')(
  function* (
    from: string,
    to: string,
    options?: { readonly overwrite?: boolean },
  ) {
    yield* Effect.tryPromise({
      try: () =>
        nodeFs.cp(from, to, {
          recursive: true,
          dereference: true,
          force: options?.overwrite ?? false,
          errorOnExist: !options?.overwrite,
        }),
      catch: (cause) => systemErrorFrom('copyDereferenced', from, cause),
    });
  },
);

/**
 * `AbsoluteFS.read`: the file's bytes decoded as UTF-8, with line endings
 * normalized. `FileSystem.readFileString` is not this -- it decodes through a
 * `TextDecoder`, which drops a leading UTF-8 BOM that the facade preserved,
 * and the editor then writes its buffer back without it.
 *
 * The caller passes the filesystem it reads from, so a rooted view answers for
 * the paths inside its root and the process filesystem answers for the rest.
 */
export const readNormalizedFile = (
  fs: FileSystem.FileSystem,
  target: string,
): Effect.Effect<string, PlatformError.PlatformError> =>
  fs
    .readFile(target)
    .pipe(
      Effect.map((bytes) =>
        normalizeLineEndings(Buffer.from(bytes).toString('utf-8')),
      ),
    );
