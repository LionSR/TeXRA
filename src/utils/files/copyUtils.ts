// Standard library imports
import * as path from 'path';

// Third-party imports
import fsExtra, { type CopyOptions } from 'fs-extra';

// Local imports - fs
import { BaseFS } from './baseFS';

/**
 * Recursively copy a directory from an absolute source path to a relative
 * destination using the provided filesystem implementation.
 *
 * @param sourcePath Absolute path to the directory to copy
 * @param destRelativePath Destination path relative to the filesystem base
 * @param destFS Filesystem class (e.g., WorkspaceFS, GlobalStorageFS)
 * @param options Optional fs-extra copy options to pass through
 */
export async function copyDirToFS(
  sourcePath: string,
  destRelativePath: string,
  destFS: typeof BaseFS,
  options: CopyOptions = {},
): Promise<void> {
  if (!path.isAbsolute(sourcePath)) {
    throw new Error(
      `copyDirToFS: sourcePath must be absolute. Received ${sourcePath}`,
    );
  }

  await destFS.ensureDir(destRelativePath);

  const destAbsolutePath = destFS.fullPath(destRelativePath);
  await fsExtra.copy(sourcePath, destAbsolutePath, {
    overwrite: true,
    ...options,
  });
}

export default copyDirToFS;
