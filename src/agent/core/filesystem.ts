/**
 * Platform-agnostic filesystem provider for the agent core.
 *
 * Delegates to a settable backend. Default: Node.js fs/promises.
 * VS Code calls `setFileSystem()` at activation to use
 * vscode.workspace.fs.
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * File type enum (bitmask-compatible with vscode.FileType).
 */
export const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
} as const;

export type FileType = (typeof FileType)[keyof typeof FileType];

/**
 * File stat result (matches vscode.FileStat shape).
 */
export interface FileStat {
  type: number;
  ctime: number;
  mtime: number;
  size: number;
}

/**
 * Platform-agnostic filesystem operations.
 *
 * All paths are absolute strings. Implementations convert to
 * platform-specific representations (e.g. vscode.Uri) internally.
 */
export interface FileSystemProvider {
  stat(path: string): Promise<FileStat>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  delete(path: string, options?: { recursive?: boolean }): Promise<void>;
  createDirectory(path: string): Promise<void>;
  readDirectory(path: string): Promise<[string, number][]>;
  copy(
    source: string,
    dest: string,
    options?: { overwrite?: boolean },
  ): Promise<void>;
  rename(
    source: string,
    dest: string,
    options?: { overwrite?: boolean },
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default backend – Node.js fs/promises (for CLI / Electron / tests)
// ---------------------------------------------------------------------------

function nodeFileType(stats: fs.Stats): number {
  let type: number = FileType.Unknown;
  if (stats.isFile()) type = FileType.File;
  else if (stats.isDirectory()) type = FileType.Directory;
  if (stats.isSymbolicLink()) type |= FileType.SymbolicLink;
  return type;
}

const nodeBackend: FileSystemProvider = {
  async stat(target: string): Promise<FileStat> {
    const stats = await fs.promises.stat(target);
    return {
      type: nodeFileType(stats),
      ctime: stats.ctimeMs,
      mtime: stats.mtimeMs,
      size: stats.size,
    };
  },

  async readFile(target: string): Promise<Uint8Array> {
    return fs.promises.readFile(target);
  },

  async writeFile(target: string, content: Uint8Array): Promise<void> {
    const dir = path.dirname(target);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(target, content);
  },

  async delete(
    target: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    const stats = await fs.promises.stat(target).catch(() => null);
    if (!stats) return;
    if (stats.isDirectory()) {
      await fs.promises.rm(target, { recursive: options?.recursive ?? false });
    } else {
      await fs.promises.unlink(target);
    }
  },

  async createDirectory(target: string): Promise<void> {
    await fs.promises.mkdir(target, { recursive: true });
  },

  async readDirectory(target: string): Promise<[string, number][]> {
    const entries = await fs.promises.readdir(target, { withFileTypes: true });
    return entries.map((entry) => {
      let type: number = FileType.Unknown;
      if (entry.isFile()) type = FileType.File;
      else if (entry.isDirectory()) type = FileType.Directory;
      if (entry.isSymbolicLink()) type |= FileType.SymbolicLink;
      return [entry.name, type] as [string, number];
    });
  },

  async copy(
    source: string,
    dest: string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    const flag = options?.overwrite ? 0 : fs.constants.COPYFILE_EXCL;
    const srcStat = await fs.promises.stat(source);
    if (srcStat.isDirectory()) {
      await fs.promises.cp(source, dest, { recursive: true, force: !!options?.overwrite });
    } else {
      const dir = path.dirname(dest);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.copyFile(source, dest, flag);
    }
  },

  async rename(
    source: string,
    dest: string,
  ): Promise<void> {
    const dir = path.dirname(dest);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.rename(source, dest);
  },
};

// ---------------------------------------------------------------------------
// Settable backend
// ---------------------------------------------------------------------------

let backend: FileSystemProvider = nodeBackend;

/** Replace the filesystem backend. Called once at platform init. */
export function setFileSystem(provider: FileSystemProvider): void {
  backend = provider;
}

/** Get the active filesystem provider. */
export function getFileSystem(): FileSystemProvider {
  return backend;
}
