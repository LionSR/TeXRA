/**
 * Platform filesystem provider interface.
 *
 * All paths are absolute strings. Implementations convert to
 * platform-specific representations (e.g. vscode.Uri) internally.
 */

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

export interface FileSystemProvider {
  stat(path: string): Promise<FileStat>;
  /**
   * Returns true when `path` is a symbolic link (does NOT follow the link).
   * Prefer this over checking the `SymbolicLink` bit from `readDirectory`
   * entries; some `vscode.workspace.fs` implementations do not set that bit.
   */
  isSymlink(path: string): Promise<boolean>;
  realPath(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  readFileChunk(
    path: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  /**
   * Crash-safe write: stage to a temp file and atomically rename over the
   * target so a torn/partial file is never observable after an unclean exit.
   * Used for durable run/flow state; plain `writeFile` remains for workspace
   * files (where atomic rename would replace a user's symlink).
   */
  writeFileAtomic(path: string, content: Uint8Array): Promise<void>;
  appendFile(path: string, content: Uint8Array): Promise<void>;
  delete(path: string, options?: { recursive?: boolean }): Promise<void>;
  createDirectory(path: string): Promise<void>;
  readDirectory(path: string): Promise<[string, number][]>;
  copy(
    source: string,
    dest: string,
    options?: { overwrite?: boolean; dereference?: boolean },
  ): Promise<void>;
  rename(
    source: string,
    dest: string,
    options?: { overwrite?: boolean },
  ): Promise<void>;
}
