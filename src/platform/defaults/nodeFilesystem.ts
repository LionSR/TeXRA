/**
 * Node.js filesystem backend for CLI / Electron / tests.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import writeFileAtomicLib from 'write-file-atomic';

import { isFileNotFoundError } from '@common/errors';

import { type FileSystemProvider, type FileStat } from '../interfaces';
import { fileTypeFor } from './fsEntryTypeBits';

export const nodeFilesystem: FileSystemProvider = {
  async stat(target: string): Promise<FileStat> {
    const lstats = await fs.promises.lstat(target);
    const type = await fileTypeFor(fs, lstats, target);
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

  // These operations intentionally use fs.promises in every host:
  // vscode.workspace.fs has no chunked-read API and reports symlinks
  // unreliably across platforms.
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
        const type = await fileTypeFor(
          fs,
          entry,
          path.join(target, entry.name),
        );
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
      const existing = await fs.promises.lstat(dest).catch((err: unknown) => {
        if (!isFileNotFoundError(err)) throw err;
        return undefined;
      });
      if (existing) {
        throw Object.assign(new Error(`Target already exists: ${dest}`), {
          code: 'EEXIST',
        });
      }
    }
    await fs.promises.rename(source, dest);
  },
};
