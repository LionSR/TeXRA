// Local imports
import { generateShortId } from '@utils/core';

export const PASTED_DIR = 'pasted';

const PASTED_PREFIX = 'pasted_';

/** Generate a pasted-image filename: `pasted_<timestamp>_<rand>.<ext>`. */
export function generatePastedImageName(ext: string): string {
  return `${PASTED_PREFIX}${Date.now()}_${generateShortId(6)}.${ext}`;
}

/** Return whether a filename uses TeXRA's pasted-image prefix. */
export function isPastedImage(filename: string): boolean {
  return filename.startsWith(PASTED_PREFIX);
}
