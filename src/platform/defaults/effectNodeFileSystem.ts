/**
 * A complete `effect/FileSystem` implementation over `node:fs`.
 *
 * Core `effect` ships no working `FileSystem` layer — only `makeNoop`, whose
 * unimplemented methods report `NotFound` for files that exist and answer
 * `exists` with `false`. That is fabricated data, not a missing feature, so a
 * partial layer cannot be used in production here (CLAUDE.md, "silent
 * degradation is a defect"). The other source of a real layer,
 * `@effect/platform-node`, pulls a non-optional `redis` peer into the
 * production install graph under this workspace's `autoInstallPeers: true`.
 *
 * This module exists so `FileSystem` can be evaluated against the repo's own
 * `FileSystemProvider` port without taking on either cost.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { Effect, Layer, Option, Stream } from 'effect';
import * as FileSystem from 'effect/FileSystem';
import { systemError, type PlatformError } from 'effect/PlatformError';
import type { SystemErrorTag } from 'effect/PlatformError';

/** Map a Node `errno` code onto Effect's normalized system-error tag. */
function tagFor(code: unknown): SystemErrorTag {
  switch (code) {
    case 'ENOENT':
      return 'NotFound';
    case 'EEXIST':
      return 'AlreadyExists';
    case 'EACCES':
    case 'EPERM':
      return 'PermissionDenied';
    case 'EBUSY':
    case 'ENOTEMPTY':
      return 'Busy';
    case 'EAGAIN':
      return 'WouldBlock';
    case 'ETIMEDOUT':
      return 'TimedOut';
    case 'EBADF':
      return 'BadResource';
    case 'EINVAL':
      return 'InvalidData';
    default:
      return 'Unknown';
  }
}

function toPlatformError(
  method: string,
  pathOrDescriptor: string | number | undefined,
  cause: unknown,
): PlatformError {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  return systemError({
    _tag: tagFor(code),
    module: 'FileSystem',
    method,
    pathOrDescriptor,
    syscall: (cause as NodeJS.ErrnoException | undefined)?.syscall,
    description: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

/** Run a `node:fs` promise, normalizing its rejection into a `PlatformError`. */
function attempt<A>(
  method: string,
  pathOrDescriptor: string | number | undefined,
  run: () => Promise<A>,
): Effect.Effect<A, PlatformError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => toPlatformError(method, pathOrDescriptor, cause),
  });
}

function typeOf(stats: fs.Stats | fs.BigIntStats): FileSystem.File.Type {
  if (stats.isFile()) return 'File';
  if (stats.isDirectory()) return 'Directory';
  if (stats.isSymbolicLink()) return 'SymbolicLink';
  if (stats.isBlockDevice()) return 'BlockDevice';
  if (stats.isCharacterDevice()) return 'CharacterDevice';
  if (stats.isFIFO()) return 'FIFO';
  if (stats.isSocket()) return 'Socket';
  return 'Unknown';
}

function toInfo(stats: fs.Stats): FileSystem.File.Info {
  return {
    type: typeOf(stats),
    mtime: Option.fromNullishOr(stats.mtime),
    atime: Option.fromNullishOr(stats.atime),
    birthtime: Option.fromNullishOr(stats.birthtime),
    dev: stats.dev,
    ino: Option.some(stats.ino),
    mode: stats.mode,
    nlink: Option.some(stats.nlink),
    uid: Option.some(stats.uid),
    gid: Option.some(stats.gid),
    rdev: Option.some(stats.rdev),
    size: FileSystem.Size(stats.size),
    blksize: Option.some(FileSystem.Size(stats.blksize)),
    blocks: Option.some(stats.blocks),
  };
}

function sizeNumber(size: FileSystem.SizeInput): number {
  return Number(FileSystem.Size(size));
}

function makeFile(
  handle: fs.promises.FileHandle,
  path: string,
): FileSystem.File {
  let position = BigInt(0);
  const file: FileSystem.File = {
    [FileSystem.FileTypeId]: FileSystem.FileTypeId,
    stat: attempt('stat', path, () => handle.stat()).pipe(Effect.map(toInfo)),
    seek: (offset, from) =>
      Effect.sync(() => {
        const delta = BigInt(FileSystem.Size(offset));
        position = from === 'start' ? delta : position + delta;
        return FileSystem.Size(position);
      }),
    sync: attempt('sync', path, () => handle.sync()),
    read: (buffer) =>
      attempt('read', path, () =>
        handle.read(buffer, 0, buffer.length, Number(position)),
      ).pipe(
        Effect.map(({ bytesRead }) => {
          position += BigInt(bytesRead);
          return FileSystem.Size(bytesRead);
        }),
      ),
    readAlloc: (size) =>
      Effect.suspend(() => {
        const buffer = new Uint8Array(sizeNumber(size));
        return file
          .read(buffer)
          .pipe(
            Effect.map((bytesRead) =>
              bytesRead === BigInt(0)
                ? Option.none()
                : Option.some(buffer.subarray(0, Number(bytesRead))),
            ),
          );
      }),
    truncate: (length) =>
      attempt('truncate', path, () =>
        handle.truncate(length === undefined ? 0 : sizeNumber(length)),
      ),
    write: (buffer) =>
      attempt('write', path, () =>
        handle.write(buffer, 0, buffer.length, Number(position)),
      ).pipe(
        Effect.map(({ bytesWritten }) => {
          position += BigInt(bytesWritten);
          return FileSystem.Size(bytesWritten);
        }),
      ),
    writeAll: (buffer) =>
      Effect.suspend(() => {
        const loop = (
          remaining: Uint8Array,
        ): Effect.Effect<void, PlatformError> =>
          remaining.length === 0
            ? Effect.void
            : file
                .write(remaining)
                .pipe(
                  Effect.flatMap((written) =>
                    loop(remaining.subarray(Number(written))),
                  ),
                );
        return loop(buffer);
      }),
  };
  return file;
}

const impl = FileSystem.make({
  access: (path, options) =>
    attempt('access', path, () => {
      let mode = fs.constants.F_OK;
      if (options?.readable === true) mode |= fs.constants.R_OK;
      if (options?.writable === true) mode |= fs.constants.W_OK;
      return fs.promises.access(path, mode);
    }),

  copy: (fromPath, toPath, options) =>
    attempt('copy', fromPath, () =>
      fs.promises.cp(fromPath, toPath, {
        recursive: true,
        force: options?.overwrite ?? false,
        errorOnExist: options?.overwrite !== true,
        preserveTimestamps: options?.preserveTimestamps ?? false,
      }),
    ),

  copyFile: (fromPath, toPath) =>
    attempt('copyFile', fromPath, () => fs.promises.copyFile(fromPath, toPath)),

  chmod: (path, mode) =>
    attempt('chmod', path, () => fs.promises.chmod(path, mode)),

  chown: (path, uid, gid) =>
    attempt('chown', path, () => fs.promises.chown(path, uid, gid)),

  glob: (pattern, options) =>
    attempt('glob', pattern, async () => {
      const matches: string[] = [];
      for await (const entry of fs.promises.glob(pattern, {
        cwd: options?.root,
        exclude:
          options?.exclude === undefined ? undefined : [...options.exclude],
      })) {
        matches.push(typeof entry === 'string' ? entry : String(entry));
      }
      return matches;
    }),

  link: (fromPath, toPath) =>
    attempt('link', fromPath, () => fs.promises.link(fromPath, toPath)),

  makeDirectory: (path, options) =>
    attempt('makeDirectory', path, () =>
      fs.promises.mkdir(path, {
        recursive: options?.recursive ?? false,
        mode: options?.mode,
      }),
    ).pipe(Effect.asVoid),

  makeTempDirectory: (options) =>
    attempt('makeTempDirectory', options?.directory, () =>
      fs.promises.mkdtemp(
        nodePath.join(options?.directory ?? os.tmpdir(), options?.prefix ?? ''),
      ),
    ),

  makeTempDirectoryScoped: (options) =>
    Effect.acquireRelease(
      attempt('makeTempDirectoryScoped', options?.directory, () =>
        fs.promises.mkdtemp(
          nodePath.join(
            options?.directory ?? os.tmpdir(),
            options?.prefix ?? '',
          ),
        ),
      ),
      (directory) =>
        Effect.ignore(
          attempt('makeTempDirectoryScoped', directory, () =>
            fs.promises.rm(directory, { recursive: true, force: true }),
          ),
        ),
    ),

  makeTempFile: (options) =>
    attempt('makeTempFile', options?.directory, async () => {
      const directory = await fs.promises.mkdtemp(
        nodePath.join(options?.directory ?? os.tmpdir(), options?.prefix ?? ''),
      );
      const file = nodePath.join(directory, `temp${options?.suffix ?? ''}`);
      await fs.promises.writeFile(file, new Uint8Array());
      return file;
    }),

  makeTempFileScoped: (options) =>
    Effect.acquireRelease(
      attempt('makeTempFileScoped', options?.directory, async () => {
        const directory = await fs.promises.mkdtemp(
          nodePath.join(
            options?.directory ?? os.tmpdir(),
            options?.prefix ?? '',
          ),
        );
        const file = nodePath.join(directory, `temp${options?.suffix ?? ''}`);
        await fs.promises.writeFile(file, new Uint8Array());
        return file;
      }),
      (file) =>
        Effect.ignore(
          attempt('makeTempFileScoped', file, () =>
            fs.promises.rm(nodePath.dirname(file), {
              recursive: true,
              force: true,
            }),
          ),
        ),
    ),

  open: (path, options) =>
    Effect.acquireRelease(
      attempt('open', path, () =>
        fs.promises.open(path, options?.flag ?? 'r', options?.mode),
      ).pipe(
        Effect.map((handle) => ({ handle, file: makeFile(handle, path) })),
      ),
      ({ handle }) =>
        Effect.ignore(attempt('close', path, () => handle.close())),
    ).pipe(Effect.map(({ file }) => file)),

  readDirectory: (path, options) =>
    attempt('readDirectory', path, () =>
      fs.promises.readdir(path, { recursive: options?.recursive ?? false }),
    ),

  readFile: (path) =>
    attempt('readFile', path, async () =>
      Uint8Array.from(await fs.promises.readFile(path)),
    ),

  readLink: (path) =>
    attempt('readLink', path, () => fs.promises.readlink(path)),

  realPath: (path) =>
    attempt('realPath', path, () => fs.promises.realpath(path)),

  remove: (path, options) =>
    attempt('remove', path, () =>
      fs.promises.rm(path, {
        recursive: options?.recursive ?? false,
        force: options?.force ?? false,
      }),
    ),

  rename: (oldPath, newPath) =>
    attempt('rename', oldPath, () => fs.promises.rename(oldPath, newPath)),

  stat: (path) =>
    attempt('stat', path, () => fs.promises.stat(path)).pipe(
      Effect.map(toInfo),
    ),

  symlink: (fromPath, toPath) =>
    attempt('symlink', fromPath, () => fs.promises.symlink(fromPath, toPath)),

  truncate: (path, length) =>
    attempt('truncate', path, () =>
      fs.promises.truncate(path, length === undefined ? 0 : sizeNumber(length)),
    ),

  utimes: (path, atime, mtime) =>
    attempt('utimes', path, () => fs.promises.utimes(path, atime, mtime)),

  watch: (path, options) =>
    Stream.fromAsyncIterable(
      fs.promises.watch(path, { recursive: options?.recursive ?? false }),
      (cause) => toPlatformError('watch', path, cause),
    ).pipe(
      // `fs.watch` reports only "rename" and "change"; a rename covers both
      // create and delete, so the entry is stat-ed to tell them apart rather
      // than reporting a guess.
      Stream.mapEffect((event) => {
        const target =
          event.filename === null ? path : nodePath.join(path, event.filename);
        if (event.eventType !== 'rename') {
          return Effect.succeed<FileSystem.WatchEvent>({
            _tag: 'Update',
            path: target,
          });
        }
        return attempt('watch', target, () => fs.promises.lstat(target)).pipe(
          Effect.as<FileSystem.WatchEvent>({ _tag: 'Create', path: target }),
          Effect.catchTag('PlatformError', (error) =>
            error.reason._tag === 'NotFound'
              ? Effect.succeed<FileSystem.WatchEvent>({
                  _tag: 'Remove',
                  path: target,
                })
              : Effect.fail(error),
          ),
        );
      }),
    ),

  writeFile: (path, data, options) =>
    attempt('writeFile', path, () =>
      fs.promises.writeFile(path, data, {
        flag: options?.flag,
        mode: options?.mode,
      }),
    ),
});

/** The `effect/FileSystem` service backed by `node:fs`. */
export const effectNodeFileSystemLayer: Layer.Layer<FileSystem.FileSystem> =
  Layer.succeed(FileSystem.FileSystem)(impl);
