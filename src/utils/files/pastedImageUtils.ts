// Standard library imports
import * as path from 'path';

// Third-party imports
import { nanoid } from 'nanoid';

// Local imports
import { StorageFS } from './storageFS';

export const PASTED_PREFIX = 'pasted_';
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

/**
 * Get a display-friendly name for a pasted image path
 * Shows just the filename for pasted images, full path for others
 */
export function getPastedImageDisplayName(fullPath: string): string {
  return fullPath.includes(`/${PASTED_DIR}/`)
    ? path.basename(fullPath)
    : fullPath;
}

/**
 * Generate a unique filename for a pasted image
 */
export function generatePastedImageName(extension: string): string {
  const timestamp = Date.now();
  const random = nanoid(6);
  return `${PASTED_PREFIX}${timestamp}_${random}.${extension}`;
}
