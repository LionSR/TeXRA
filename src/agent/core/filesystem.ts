/**
 * Filesystem facade — convenience wrapper over platform().fs.
 *
 * Also re-exports FileType and FileStat from the canonical interface
 * for backward compatibility.
 */
import { platform } from '@platform/platform';
import type { FileSystemProvider, FileStat } from '@platform/interfaces/filesystem';
import { FileType } from '@platform/interfaces/filesystem';

export { FileType };
export type { FileSystemProvider, FileStat };

export function getFileSystem(): FileSystemProvider {
  return platform().fs;
}
