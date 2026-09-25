/** Resolve the SQLite path only after establishing local filesystem storage. */
// Native filesystem and mount information
import { lstatSync, mkdirSync, realpathSync, statfsSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';
import * as ChildProcess from 'effect/unstable/process/ChildProcess';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';
import { ensureError } from '@utils/errors/errorMessage';
import type { PlatformError } from 'effect/PlatformError';

/** Local Linux filesystem types from include/uapi/linux/magic.h. Network,
 * clustered and unclassified FUSE filesystems are deliberately absent. */
const LOCAL_LINUX_FILESYSTEMS = new Set([
  0xef53, // ext2, ext3, ext4
  0x58465342, // XFS
  0x9123683e, // Btrfs
  0x01021994, // tmpfs
  0x794c7630, // overlayfs
  0x2fc12fc1, // ZFS
  0xf2f52010, // F2FS
  0x3153464a, // JFS
  0x52654973, // ReiserFS
  0x3434, // NILFS
  0x42465331, // BFS
  0x28cd3d45, // cramfs
  0x73717368, // squashfs
  0x4d44, // FAT
  0x2011bab0, // exFAT
  0x5346544e, // NTFS
]);

/** Whether the mount table `mountOutput` (`/sbin/mount`'s) marks the
 * longest mount containing `directory` as local. */
function isLocalInMountTable(directory: string, mountOutput: string): boolean {
  const mounts = mountOutput
    .trimEnd()
    .split('\n')
    .flatMap((line) => {
      const match = /^.* on (.*) \(([^)]*)\)$/.exec(line);
      if (!match)
        throw new Error('Cannot interpret the filesystem mount table.');
      const [, mount, flags] = match;
      return directory === mount ||
        directory.startsWith(mount === '/' ? '/' : `${mount}/`)
        ? [{ mount, local: flags.split(', ').includes('local') }]
        : [];
    })
    .toSorted((a, b) => b.mount.length - a.mount.length);
  return mounts[0]?.local === true;
}

/** macOS exposes MNT_LOCAL in mount output, but Node's statfs omits flags.
 * `string` does not read the exit code; an empty table is the failure. */
const isLocalMacDirectory = Effect.fnUntraced(function* (directory: string) {
  const spawner = yield* ChildProcessSpawner;
  const output = yield* spawner.string(
    ChildProcess.make('/sbin/mount', [], {
      stdin: 'ignore',
      stderr: 'ignore',
      detached: false,
      forceKillAfter: '5 seconds',
    }),
  );
  if (output.trim() === '') {
    return yield* Effect.fail(
      new Error('Cannot read the filesystem mount table.'),
    );
  }
  return yield* Effect.try({
    try: () => isLocalInMountTable(directory, output),
    catch: ensureError,
  });
});

/** Whether the filesystem holding `resolved` is verified local. */
function isLocalDirectory(
  resolved: string,
): Effect.Effect<boolean, Error | PlatformError, ChildProcessSpawner> {
  switch (platform()) {
    case 'darwin':
      return isLocalMacDirectory(resolved);
    case 'linux':
      return Effect.try({
        try: () => LOCAL_LINUX_FILESYSTEMS.has(statfsSync(resolved).type),
        catch: ensureError,
      });
    case 'win32':
      return Effect.succeed(/^[a-z]:\\/i.test(resolved));
    default:
      return Effect.succeed(false);
  }
}

/**
 * Create `directory` and answer the database path inside it.
 *
 * C1: reject remote or unclassified storage before SQLite opens. The native
 * Windows realpath uses GetFinalPathNameByHandleW, resolving junctions and
 * mapped shares to their final DOS or UNC path. A UNC result is not local.
 * https://docs.libuv.org/en/v1.x/fs.html#c.uv_fs_realpath
 */
export const localDatabasePath = Effect.fn('localDatabasePath')(function* (
  directory: string,
  fileName: string,
): Effect.fn.Return<string, Error | PlatformError, ChildProcessSpawner> {
  const resolved = yield* Effect.try({
    try: () => {
      mkdirSync(directory, { recursive: true });
      return realpathSync.native(directory);
    },
    catch: ensureError,
  });
  if (!(yield* isLocalDirectory(resolved))) {
    return yield* Effect.fail(
      new Error(
        `Session storage must be on a verified local filesystem: ${resolved}`,
      ),
    );
  }
  const database = join(resolved, fileName);
  for (const file of [database, `${database}-wal`, `${database}-shm`]) {
    const link = yield* Effect.try({
      try: () => lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink(),
      catch: ensureError,
    });
    if (link) {
      return yield* Effect.fail(
        new Error(`A session database file cannot be a symbolic link: ${file}`),
      );
    }
  }
  return database;
});
