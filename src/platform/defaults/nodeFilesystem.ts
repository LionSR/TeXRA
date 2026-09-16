/**
 * Node.js filesystem backend for CLI / Electron / tests.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import writeFileAtomicLib from 'write-file-atomic';

import { isFileNotFoundError } from '@common/errors';

import {
  type FileSystemProvider,
  type FileStat,
  FileType,
} from '../interfaces';
import { fileTypeBitsOf, fileTypeFor } from './fsEntryTypeBits';

export const nodeFilesystem: FileSystemProvider = {
  async stat(target: string): Promise<FileStat> {
    const lstats = await fs.promises.lstat(target);
    // For symlinks, use stat (follows link) for size/timestamps and for the
    // target's own type, to match vscode.workspace.fs.stat behavior, falling
    // back to lstat metadata for a dangling symlink. For non-symlinks,
    // lstat === stat. One lookup answers both, so a type and the metadata it
    // describes can never come from two different reads of the target.
    const stats = lstats.isSymbolicLink()
      ? await fs.promises.stat(target).catch(() => lstats)
      : lstats;
    return {
      type:
        fileTypeBitsOf(stats) |
        (lstats.isSymbolicLink() ? FileType.SymbolicLink : 0),
      ctime: stats.ctimeMs,
      mtime: stats.mtimeMs,
      size: stats.size,
    };
  },

  // These operations intentionally use fs.promises in every host:
  // vscode.workspace.fs reports symlinks unreliably across platforms.
  async isSymlink(target: string): Promise<boolean> {
    const lstats = await fs.promises.lstat(target);
    return lstats.isSymbolicLink();
  },

  async readFile(target: string): Promise<Uint8Array> {
    return fs.promises.readFile(target);
  },

  async writeFile(target: string, content: Uint8Array): Promise<void> {
    await fs.promises.writeFile(target, content);
  },

  async writeFileAtomic(target: string, content: Uint8Array): Promise<void> {
    // write-file-atomic stages to a sibling temp, fsyncs, and renames over the
    // target — resolving the realpath first, so a symlinked path is preserved.
    await writeFileAtomicLib(target, Buffer.from(content));
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
