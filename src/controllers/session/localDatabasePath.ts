/** Resolve the SQLite path only after establishing local filesystem storage. */
// Native filesystem and mount information
import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync, statfsSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

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

/** macOS exposes MNT_LOCAL in mount output, but Node's statfs omits flags. */
function isLocalMacDirectory(directory: string): boolean {
  const mounts = execFileSync('/sbin/mount', { encoding: 'utf8' })
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

/**
 * C1: reject remote or unclassified storage before SQLite opens. The native
 * Windows realpath uses GetFinalPathNameByHandleW, resolving junctions and
 * mapped shares to their final DOS or UNC path. A UNC result is not local.
 * https://docs.libuv.org/en/v1.x/fs.html#c.uv_fs_realpath
 */
export function localDatabasePath(directory: string, fileName: string): string {
  const resolved = realpathSync.native(directory);
  let local: boolean;
  switch (platform()) {
    case 'darwin':
      local = isLocalMacDirectory(resolved);
      break;
    case 'linux':
      local = LOCAL_LINUX_FILESYSTEMS.has(statfsSync(resolved).type);
      break;
    case 'win32':
      local = /^[a-z]:\\/i.test(resolved);
      break;
    default:
      local = false;
  }
  if (!local) {
    throw new Error(
      `Session storage must be on a verified local filesystem: ${resolved}`,
    );
  }
  const database = join(resolved, fileName);
  for (const file of [database, `${database}-wal`, `${database}-shm`]) {
    if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(
        `A session database file cannot be a symbolic link: ${file}`,
      );
    }
  }
  return database;
}
