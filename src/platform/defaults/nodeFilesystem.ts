/**
 * Node.js filesystem backend for CLI / Electron / tests.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import writeFileAtomicLib from 'write-file-atomic';

import { isFileNotFoundError } from '@common/errors';

import {
  FileType,
  type FileSystemProvider,
  type FileStat,
} from '../interfaces';

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
 * Compute the bitmask file type for an lstat result or a directory entry.
 *
 * Node's Stats/Dirent type predicates are mutually exclusive: a symlink reports
 * isSymbolicLink() but not isFile()/isDirectory(), so we resolve the symlink
 * target to produce combined bitmasks matching vscode.FileType. `target` is the
 * entry's own path; for readDirectory, join the parent dir with the entry name.
 */
async function fileTypeFor(
  entry: Pick<fs.Stats, 'isSymbolicLink' | 'isFile' | 'isDirectory'>,
  target: string,
): Promise<number> {
  if (entry.isSymbolicLink()) return resolveSymlinkType(target);
  if (entry.isFile()) return FileType.File;
  if (entry.isDirectory()) return FileType.Directory;
  return FileType.Unknown;
}

export const nodeFilesystem: FileSystemProvider = {
  async stat(target: string): Promise<FileStat> {
    const lstats = await fs.promises.lstat(target);
    const type = await fileTypeFor(lstats, target);
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

  async isSymlink(target: string): Promise<boolean> {
    const lstats = await fs.promises.lstat(target);
    return lstats.isSymbolicLink();
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

  async writeFileAtomic(target: string, content: Uint8Array): Promise<void> {
    // write-file-atomic stages to a sibling temp, fsyncs, and renames over the
    // target — resolving the realpath first, so a symlinked path is preserved.
    await writeFileAtomicLib(target, Buffer.from(content));
  },

  async appendFile(target: string, content: Uint8Array): Promise<void> {
    await fs.promises.appendFile(target, content);
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
        const type = await fileTypeFor(entry, path.join(target, entry.name));
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
