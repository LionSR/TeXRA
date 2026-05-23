/**
 * Node.js filesystem backend for CLI / Electron / tests.
 */
import * as fs from 'fs';
import * as path from 'path';

import { isFileNotFoundError } from '@common/errors';

import {
  FileType,
  type FileSystemProvider,
  type FileStat,
} from '../interfaces/filesystem';

/**
 * Resolve the target type of a symlink, producing combined bitmasks
 * (e.g. SymbolicLink | File = 65) matching vscode.FileType behavior.
 */
async function resolveSymlinkType(target: string): Promise<number> {
  let targetType: number = FileType.Unknown;
  try {
    const stats = await fs.promises.stat(target);
    if (stats.isFile()) targetType = FileType.File;
    else if (stats.isDirectory()) targetType = FileType.Directory;
  } catch {
    // Dangling symlink — target type stays Unknown
  }
  return FileType.SymbolicLink | targetType;
}

/**
 * Compute the bitmask file type from an lstat result.
 * For symlinks, resolves the target path to produce combined bitmasks.
 */
async function lstatFileType(
  lstats: fs.Stats,
  target: string,
): Promise<number> {
  if (!lstats.isSymbolicLink()) {
    if (lstats.isFile()) return FileType.File;
    if (lstats.isDirectory()) return FileType.Directory;
    return FileType.Unknown;
  }
  return resolveSymlinkType(target);
}

/**
 * Compute bitmask file type for a directory entry.
 *
 * Node.js Dirent methods are mutually exclusive: for symlinks, isSymbolicLink()
 * is true but isFile()/isDirectory() are false. We resolve the symlink target
 * to produce combined bitmasks matching vscode.FileType.
 */
async function direntFileType(
  entry: fs.Dirent,
  parentDir: string,
): Promise<number> {
  if (!entry.isSymbolicLink()) {
    if (entry.isFile()) return FileType.File;
    if (entry.isDirectory()) return FileType.Directory;
    return FileType.Unknown;
  }
  return resolveSymlinkType(path.join(parentDir, entry.name));
}

export const nodeFilesystem: FileSystemProvider = {
  async stat(target: string): Promise<FileStat> {
    const lstats = await fs.promises.lstat(target);
    const type = await lstatFileType(lstats, target);
    // For symlinks, use stat (follows link) for size/timestamps to match
    // vscode.workspace.fs.stat behavior. For non-symlinks, lstat === stat.
    if (lstats.isSymbolicLink()) {
      try {
        const stats = await fs.promises.stat(target);
        return {
          type,
          ctime: stats.ctimeMs,
          mtime: stats.mtimeMs,
          size: stats.size,
        };
      } catch {
        // Dangling symlink — fall through to lstat metadata
      }
    }
    return {
      type,
      ctime: lstats.ctimeMs,
      mtime: lstats.mtimeMs,
      size: lstats.size,
    };
  },

  async realPath(target: string): Promise<string> {
    return fs.promises.realpath(target);
  },

  async readFile(target: string): Promise<Uint8Array> {
    return fs.promises.readFile(target);
  },

  async readFileChunk(
    target: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    const handle = await fs.promises.open(target, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },

  async writeFile(target: string, content: Uint8Array): Promise<void> {
    await fs.promises.writeFile(target, content);
  },

  async delete(
    target: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    try {
      // Use lstat so dangling/circular symlinks are detected and removed
      const stats = await fs.promises.lstat(target);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        await fs.promises.unlink(target);
      } else {
        await fs.promises.rm(target, {
          recursive: options?.recursive ?? false,
        });
      }
    } catch (err) {
      if (!isFileNotFoundError(err)) throw err;
    }
  },

  async createDirectory(target: string): Promise<void> {
    await fs.promises.mkdir(target, { recursive: true });
  },

  async readDirectory(target: string): Promise<[string, number][]> {
    const entries = await fs.promises.readdir(target, { withFileTypes: true });
    return Promise.all(
      entries.map(async (entry) => {
        const type = await direntFileType(entry, target);
        return [entry.name, type] as [string, number];
      }),
    );
  },

  async copy(
    source: string,
    dest: string,
    options?: { overwrite?: boolean; dereference?: boolean },
  ): Promise<void> {
    const srcStat = await fs.promises.stat(source);
    if (srcStat.isDirectory()) {
      await fs.promises.cp(source, dest, {
        recursive: true,
        force: !!options?.overwrite,
        errorOnExist: !options?.overwrite,
        dereference: !!options?.dereference,
      });
    } else {
      const flag = options?.overwrite ? 0 : fs.constants.COPYFILE_EXCL;
      await fs.promises.copyFile(source, dest, flag);
    }
  },

  async rename(
    source: string,
    dest: string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    if (!options?.overwrite) {
      try {
        await fs.promises.lstat(dest);
        throw Object.assign(new Error(`Target already exists: ${dest}`), {
          code: 'EEXIST',
        });
      } catch (err) {
        if (!isFileNotFoundError(err)) throw err;
      }
    }
    await fs.promises.rename(source, dest);
  },
};
