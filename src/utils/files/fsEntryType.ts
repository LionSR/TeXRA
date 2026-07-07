/**
 * File system entry type helpers — bitwise checks for symlink-aware
 * file type detection. Uses FileType from @platform/interfaces
 * as the single source of truth.
 */
import { FileType } from '@platform/interfaces';

/**
 * Check if a file system entry type represents a file (including symlinks to files).
 * Uses bitwise check to handle symbolic links correctly.
 */
export function isFile(type: number): boolean {
  return (type & FileType.File) === FileType.File;
}

/**
 * Check if a file system entry type represents a directory (including symlinks to directories).
 * Uses bitwise check to handle symbolic links correctly.
 */
export function isDirectory(type: number): boolean {
  return (type & FileType.Directory) === FileType.Directory;
}

/**
 * Check if a file system entry type represents a symbolic link.
 * Callers that traverse directories should skip symlinks (or maintain a
 * realpath/visited set) to avoid cycles.
 */
export function isSymlink(type: number): boolean {
  return (type & FileType.SymbolicLink) === FileType.SymbolicLink;
}
