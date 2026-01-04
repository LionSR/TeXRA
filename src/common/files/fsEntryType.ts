/**
 * Platform-agnostic file system entry type utilities.
 *
 * These constants and helpers enable agent core logic to check file system
 * entry types without importing vscode directly. Values match vscode.FileType
 * for compatibility with VS Code's filesystem API.
 *
 * Note: VS Code's FileType uses bitmasks - a symbolic link to a file has
 * type 65 (SymbolicLink | File). The helpers below use bitwise checks to
 * correctly handle symbolic links.
 */

/**
 * File system entry type constants.
 * Values match vscode.FileType for seamless interop.
 *
 * Note: These are bitmask values - symbolic links combine with File/Directory:
 * - File: 1
 * - Directory: 2
 * - SymbolicLink to file: 65 (64 | 1)
 * - SymbolicLink to directory: 66 (64 | 2)
 */
export const FSEntryType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
} as const;

export type FSEntryTypeValue = (typeof FSEntryType)[keyof typeof FSEntryType];

/**
 * Check if a file system entry type represents a file (including symlinks to files).
 * Uses bitwise check to handle symbolic links correctly.
 */
export function isFile(type: number): boolean {
  return (type & FSEntryType.File) === FSEntryType.File;
}

/**
 * Check if a file system entry type represents a directory (including symlinks to directories).
 * Uses bitwise check to handle symbolic links correctly.
 */
export function isDirectory(type: number): boolean {
  return (type & FSEntryType.Directory) === FSEntryType.Directory;
}
