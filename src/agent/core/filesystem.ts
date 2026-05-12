/**
 * Filesystem facade — convenience wrapper over platform().fs.
 */
import { platform } from '@platform/platform';

export function getFileSystem() {
  return platform().fs;
}
