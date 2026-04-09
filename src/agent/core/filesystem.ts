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

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

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

const nodeBackend: FileSystemProvider = {
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

  async readFile(target: string): Promise<Uint8Array> {
    return fs.promises.readFile(target);
  },

  async writeFile(target: string, content: Uint8Array): Promise<void> {
    await fs.promises.writeFile(target, content);
  },

  async delete(
    target: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    try {
      const stats = await fs.promises.stat(target);
      if (stats.isDirectory()) {
        await fs.promises.rm(target, {
          recursive: options?.recursive ?? false,
        });
      } else {
        await fs.promises.unlink(target);
      }
    } catch (err) {
      if (!isNotFound(err)) throw err;
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
    options?: { overwrite?: boolean },
  ): Promise<void> {
    const srcStat = await fs.promises.stat(source);
    if (srcStat.isDirectory()) {
      await fs.promises.cp(source, dest, {
        recursive: true,
        force: !!options?.overwrite,
        errorOnExist: !options?.overwrite,
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
      // Check if dest exists — POSIX rename silently overwrites by default
      try {
        await fs.promises.lstat(dest);
        throw Object.assign(new Error(`Target already exists: ${dest}`), {
          code: 'EEXIST',
        });
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }
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
