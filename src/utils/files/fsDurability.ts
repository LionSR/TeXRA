/**
 * The filesystem primitives the repo must keep that the standard library's
 * `FileSystem` does not provide: crash-safe replace, single-writer publish,
 * empty-directory removal, a directory listing carrying each entry's type,
 * and a symlink-dereferencing copy.
 *
 * These are the Effect form of what `baseFS.ts` reached `platform().fs` for.
 * Nothing here re-implements an operation `FileSystem` already has — an
 * append, for instance, is `fs.writeFile(path, data, { flag: 'a' })` and gets
 * no wrapper — and the two that must call Node directly (`rmdir`, and `cp`
 * with `dereference`) classify their errno exactly as `@effect/platform-node`
 * does, so a consumer matches `SystemError` by `reason._tag` either way.
 */

// Node imports
import * as nodeFs from 'node:fs/promises';

// Third-party imports
import { Effect, FileSystem, Path, PlatformError } from 'effect';

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

/** Distinguishes the staging names of concurrent writers in one process. */
let stagingSequence = 0;

/**
 * Write `data` to `staging`, fsync it, then rename it over `target`, so the
 * target is either the old file or the whole new one — never a truncated
 * one — after an unclean exit. A failed write takes its staging file with it.
 */
const stageAndRename = Effect.fn('fsDurability.stageAndRename')(function* (
  target: string,
  staging: string,
  data: Uint8Array,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(staging, { flag: 'w' });
      yield* file.writeAll(data);
      yield* file.sync;
    }),
  ).pipe(
    Effect.onError(() => Effect.ignore(fs.remove(staging, { force: true }))),
  );
  yield* fs.rename(staging, target);
});

/**
 * Crash-safe replace: stage beside the target, fsync, rename over it. For
 * durable state a torn file would make unreadable on resume. Not for
 * workspace files — the rename replaces a user's symlink with a regular
 * file, which is why the target's real path is resolved first.
 */
export const writeFileAtomic = Effect.fn('fsDurability.writeFileAtomic')(
  function* (target: string, data: Uint8Array) {
    const fs = yield* FileSystem.FileSystem;
    const real = yield* fs.realPath(target).pipe(
      // A target that does not exist yet is its own real path.
      Effect.catchIf(
        (error) => error.reason._tag === 'NotFound',
        () => Effect.succeed(target),
      ),
    );
    stagingSequence += 1;
    yield* stageAndRename(
      real,
      `${real}.${Date.now().toString(36)}.${stagingSequence}.tmp`,
      data,
    );
  },
);

/**
 * Publish a name that belongs to exactly one writer (a run-lease claim):
 * staged, fsynced, then renamed into place, so it is either absent or
 * complete and durable. The fixed `.tmp` sibling is safe precisely because
 * the name has one publisher.
 */
export const publishFile = Effect.fn('fsDurability.publishFile')(function* (
  target: string,
  data: Uint8Array,
) {
  yield* stageAndRename(target, `${target}.tmp`, data);
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

/**
 * The entries of `target` with the type of each: one `stat` per entry, which
 * is what a caller deciding "file or directory?" per entry needs and what
 * `FileSystem.readDirectory`, returning names alone, does not carry.
 */
export const readDirectoryTyped = Effect.fn('fsDurability.readDirectoryTyped')(
  function* (target: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = yield* fs.readDirectory(target);
    return yield* Effect.forEach(
      names,
      (name) =>
        Effect.map(
          fs.stat(path.join(target, name)),
          (info) => [name, info.type] as const,
        ),
      { concurrency: 'unbounded' },
    );
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
