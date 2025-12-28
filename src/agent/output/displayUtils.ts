// Standard library imports
import * as path from 'path';

// Local imports
import type { FileLocation } from '@utils/files';

/**
 * Get directory path from a FileLocation, handling all location types.
 * Returns the directory portion without the filename.
 */
export function getFileDirectory(location: FileLocation): string {
  if (location.kind === 'workspace' || location.kind === 'runStorage') {
    return path.dirname(location.relativePath);
  }
  return path.dirname(location.absolutePath);
}
