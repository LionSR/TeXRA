/**
 * The filesystem primitives the repo must keep that the standard library's
 * `FileSystem` does not provide: crash-safe replace, single-writer publish,
 * empty-directory removal, a directory listing carrying each entry's own
 * (unfollowed) type, and exclusive or symlink-dereferencing copies.
 *
 * These are the Effect form of what `baseFS.ts` reached `platform().fs` for.
 * Nothing here re-implements an operation `FileSystem` already has — an
 * append, for instance, is `fs.writeFile(path, data, { flag: 'a' })` and gets
 * no wrapper. The Node calls `FileSystem` cannot express (`rmdir`, `lstat`,
 * `copyFile` with `COPYFILE_EXCL`, `cp` with `dereference`, and the
 * `write-file-atomic` package) classify their errno exactly as
 * `@effect/platform-node` does, so a consumer matches `SystemError` by
 * `reason._tag` either way.
 */

// Node imports
import { randomBytes } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { pid } from 'node:process';

// Third-party imports
import { Effect, FileSystem, Path, PlatformError } from 'effect';
import writeFileAtomicLib from 'write-file-atomic';

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
  ENOTEMPTY: 'Busy',
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

/**
 * Publish a name that belongs to exactly one writer (a run-lease claim):
 * staged, fsynced, then renamed into place, so it is either absent or
 * complete and durable. The staging name carries the process id and random
 * bytes and is created exclusively, so two processes racing for the same
 * name never write through one staging file: each rename installs one
 * complete file. A failed write takes its staging file with it.
 */
export const publishFile = Effect.fn('fsDurability.publishFile')(function* (
  target: string,
  data: Uint8Array,
) {
  const fs = yield* FileSystem.FileSystem;
  const staging = `${target}.${pid}.${randomBytes(6).toString('hex')}.tmp`;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(staging, { flag: 'wx' });
      yield* file.writeAll(data);
      yield* file.sync;
    }),
  ).pipe(
    Effect.onError(() => Effect.ignore(fs.remove(staging, { force: true }))),
  );
  yield* fs.rename(staging, target);
});

/**
 * Remove `target` only if it is an empty directory — `rmdir`, which
 * `FileSystem.remove` cannot express: its non-recursive form rejects a
 * directory outright, and its recursive form would delete the contents a
 * concurrent writer added since the last listing.
 */
export const removeEmptyDirectory = Effect.fn(
  'fsDurability.removeEmptyDirectory',
)(function* (target: string) {
  yield* Effect.tryPromise({
    try: () => nodeFs.rmdir(target),
    catch: (cause) => systemErrorFrom('removeEmptyDirectory', target, cause),
  });
});

/** An `lstat` result as `FileSystem`'s entry type: a link is itself. */
function entryTypeOf(stats: Stats): FileSystem.File.Type {
  if (stats.isSymbolicLink()) return 'SymbolicLink';
  if (stats.isFile()) return 'File';
  if (stats.isDirectory()) return 'Directory';
  if (stats.isBlockDevice()) return 'BlockDevice';
  if (stats.isCharacterDevice()) return 'CharacterDevice';
  if (stats.isFIFO()) return 'FIFO';
  if (stats.isSocket()) return 'Socket';
  return 'Unknown';
}

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
