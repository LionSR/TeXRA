/** Resolve the SQLite path only after establishing local filesystem storage. */
// Native filesystem and mount information
import { lstatSync, mkdirSync, realpathSync, statfsSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';
import * as ChildProcess from 'effect/process/ChildProcess';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import { ensureError } from '@utils/errors/errorMessage';
import { STORE_FILE_SUFFIXES } from './storeAside';
import type { PlatformError } from 'effect/PlatformError';

/** The Linux filesystem types (`statfs` `f_type`) a store is refused on:
 * network and clustered filesystems, where the shared-memory index WAL
 * keeps beside the store is unsafe, and FUSE, which does not say what is
 * behind it (GlusterFS, sshfs). Every other type is accepted, so a local
 * filesystem needs no entry. From include/uapi/linux/magic.h unless a line
 * names another header. */
const REMOTE_LINUX_FILESYSTEMS = new Set([
  0x6969, // NFS
  0x517b, // SMB
  0xff534d42, // CIFS
  0xfe534d42, // SMB2
  0x01021997, // 9p
  0x00c36400, // Ceph
  0x5346414f, // AFS (OpenAFS)
  0x6b414653, // AFS (the kernel's client)
  0x7461636f, // OCFS2
  0x01161970, // GFS2 (include/uapi/linux/gfs2_ondisk.h)
  0x0bd00bd0, // Lustre (lustre_user.h, in the kernel tree until 4.17)
  0x65735546, // FUSE
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

/** Whether the filesystem holding `resolved` is local: marked so in the
 * mount table on macOS, not a known remote type on Linux, a drive letter on
 * Windows. */
function isLocalDirectory(
  resolved: string,
): Effect.Effect<boolean, Error | PlatformError, ChildProcessSpawner> {
  switch (platform()) {
    case 'darwin':
      return isLocalMacDirectory(resolved);
    case 'linux':
      return Effect.try({
        try: () => !REMOTE_LINUX_FILESYSTEMS.has(statfsSync(resolved).type),
        catch: ensureError,
      });
    case 'win32':
      return Effect.succeed(/^[a-z]:\\/i.test(resolved));
    default:
      return Effect.succeed(false);
  }
}

/**
 * Create `directory` (with `create`; without, it must exist, and the caller
 * opens the file with SQLite's URI `mode=rw`, which never makes one) and
 * answer the database path inside it.
 *
 * Reject remote storage before SQLite opens: WAL does not work over a
 * network filesystem. The native Windows realpath uses
 * GetFinalPathNameByHandleW, resolving junctions and mapped shares to their
 * final DOS or UNC path. A UNC result is not local.
 * https://docs.libuv.org/en/v1.x/fs.html#c.uv_fs_realpath
 */
export const localDatabasePath = Effect.fn('localDatabasePath')(function* (
  directory: string,
  fileName: string,
  create: boolean,
): Effect.fn.Return<string, Error | PlatformError, ChildProcessSpawner> {
  const resolved = yield* Effect.try({
    try: () => {
      if (create) mkdirSync(directory, { recursive: true });
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
  for (const file of STORE_FILE_SUFFIXES.map((s) => `${database}${s}`)) {
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
