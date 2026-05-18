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
  realPath(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  readFileChunk(
    path: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
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
