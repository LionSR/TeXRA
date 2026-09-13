/**
 * Shared fs-entry-type bitmask resolution for the FileSystemProvider
 * `stat` / `readDirectory` implementations.
 */
import * as fs from 'node:fs';

import { FileType } from '../interfaces';

type FileTypeProbe = {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
};

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
export async function fileTypeFor(
  entry: FileTypeProbe,
  target: string,
): Promise<number> {
  if (entry.isSymbolicLink()) return resolveSymlinkType(target);
  if (entry.isFile()) return FileType.File;
  if (entry.isDirectory()) return FileType.Directory;
  return FileType.Unknown;
}
