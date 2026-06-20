import { nanoid } from 'nanoid';

export const PASTED_PREFIX = 'pasted_';

/** Generate a pasted-image filename: `pasted_<timestamp>_<rand>.<ext>`. */
export function generatePastedImageName(ext: string): string {
  return `${PASTED_PREFIX}${Date.now()}_${nanoid(6)}.${ext}`;
}
