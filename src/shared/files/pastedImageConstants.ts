import { nanoid } from 'nanoid';

export const PASTED_PREFIX = 'pasted_';

/**
 * Generate a pasted-image filename: `pasted_<timestamp>_<rand>.<ext>`. The
 * `PASTED_PREFIX` lets `isPastedImage` recognize it later.
 *
 * This is the single source of truth shared by the Node host
 * (`@utils/files/pastedImageUtils`) and the browser-safe webview helper
 * (`@shared/utils/clipboardImages`) so both produce identical names. It depends
 * only on `nanoid` (isomorphic) and the prefix constant, so it stays safe in
 * both bundles.
 */
export function generatePastedImageName(ext: string): string {
  return `${PASTED_PREFIX}${Date.now()}_${nanoid(6)}.${ext}`;
}
