// Standard library imports
import * as path from 'path';

// Local imports - fs
import { AbsoluteFS } from './absoluteFS';

type FileSystem = {
  createDir(relativePath: string): Promise<void>;
  write(relativePath: string, content: Uint8Array): Promise<void>;
};

/**
 * Recursively copy a directory from an absolute source path to a relative
 * destination using the provided filesystem implementation.
 *
 * @param sourcePath Absolute path to the directory to copy
 * @param destRelativePath Destination path relative to the filesystem base
 * @param destFS Filesystem class (e.g., WorkspaceFS, GlobalStorageFS)
 */
export async function copyDirToFS(
  sourcePath: string,
  destRelativePath: string,
  destFS: FileSystem,
): Promise<void> {
  await destFS.createDir(destRelativePath);
  const entries = AbsoluteFS.readDirSync(sourcePath);
  for (const entry of entries) {
    const srcEntry = path.join(sourcePath, entry);
    const destEntryRel = path.join(destRelativePath, entry);
    const stats = AbsoluteFS.statSync(srcEntry);
    if (stats.isDirectory()) {
      await copyDirToFS(srcEntry, destEntryRel, destFS);
    } else {
      const data = AbsoluteFS.readBytesSync(srcEntry);
      await destFS.write(destEntryRel, data);
    }
  }
}

export default copyDirToFS;
