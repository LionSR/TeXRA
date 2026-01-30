// Standard library imports
import * as path from 'path';

// Local imports
import { PASTED_PREFIX } from '@shared/files/pastedImageConstants';
import { StorageFS } from './storageFS';

export { PASTED_PREFIX };
export const PASTED_DIR = 'pasted';

/**
 * Check if a filename is a pasted image
 */
export function isPastedImage(filename: string): boolean {
  return filename.startsWith(PASTED_PREFIX);
}

/**
 * Get the full filesystem path for a pasted image
 */
export function getPastedImageFullPath(filename: string): string {
  return StorageFS.fullPath(path.join(PASTED_DIR, filename));
}
