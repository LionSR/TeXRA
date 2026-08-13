/**
 * Shared fs-entry-type bitmask resolution for FileSystemProvider.stat/readDirectory
 * implementations, parameterized on a minimal duck-typed stat-capable fs handle so
 * both node:fs and memfs's IFs (used by the test-kernel fake platform) can share it.
 */
import { FileType } from '../interfaces';

export type FileTypeProbe = {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
};

type StatCapableFs = {
  promises: {
    stat(
      target: string,
    ): Promise<Pick<FileTypeProbe, 'isFile' | 'isDirectory'>>;
  };
};

/**
 * Resolve the target type of a symlink, producing combined bitmasks
 * (e.g. SymbolicLink | File = 65) matching vscode.FileType behavior.
 */
async function resolveSymlinkType(
  fs: StatCapableFs,
  target: string,
): Promise<number> {
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
  fs: StatCapableFs,
  entry: FileTypeProbe,
  target: string,
): Promise<number> {
  if (entry.isSymbolicLink()) return resolveSymlinkType(fs, target);
  if (entry.isFile()) return FileType.File;
  if (entry.isDirectory()) return FileType.Directory;
  return FileType.Unknown;
}
