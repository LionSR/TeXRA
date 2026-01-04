/**
 * Platform-agnostic file system entry type utilities.
 *
 * These constants and helpers enable agent core logic to check file system
 * entry types without importing vscode directly. Values match vscode.FileType
 * for compatibility with VS Code's filesystem API.
 */

/**
 * File system entry type constants.
 * Values match vscode.FileType for seamless interop.
 */
export const FSEntryType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
} as const;

export type FSEntryTypeValue = (typeof FSEntryType)[keyof typeof FSEntryType];

/**
 * Check if a file system entry type represents a regular file.
 */
export function isFile(type: number): boolean {
  return type === FSEntryType.File;
}

/**
 * Check if a file system entry type represents a directory.
 */
export function isDirectory(type: number): boolean {
  return type === FSEntryType.Directory;
}
