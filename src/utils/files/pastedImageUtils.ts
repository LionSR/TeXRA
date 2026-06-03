// Standard library imports
import { randomBytes } from 'node:crypto';
import * as path from 'path';

// Local imports
import { PASTED_PREFIX } from '@shared/files/pastedImageConstants';
import { THREE_DAYS_MS } from '@utils/config/constants';
import { StorageFS } from './storageFS';

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
 * Generate a pasted-image filename: `pasted_<timestamp>_<rand>.<ext>`. The
 * `PASTED_PREFIX` lets {@link isPastedImage} recognize it later.
 */
export function generatePastedImageName(ext: string): string {
  return `${PASTED_PREFIX}${Date.now()}_${randomBytes(4).toString('hex')}.${ext}`;
}

/**
 * Persist pasted image bytes into the shared `pasted/` storage dir and return
 * the absolute path. Shared by the extension webview host and the CLI so both
 * produce identical on-disk media files that flow through the same
 * MediaAttachmentProcessor path — no duplicated encoding.
 */
export async function savePastedImageBuffer(
  data: Buffer,
  fileName: string,
): Promise<string> {
  // Defensive: a pasted filename can arrive from a webview message, so strip
  // any directory components to keep the write inside PASTED_DIR — no `../`
  // traversal or absolute-path escape.
  const safeName = path.basename(fileName);
  await StorageFS.ensureDir(PASTED_DIR);
  const relativePath = path.join(PASTED_DIR, safeName);
  await StorageFS.write(relativePath, data);
  await StorageFS.cleanupOldFiles(PASTED_DIR, THREE_DAYS_MS);
  return StorageFS.fullPath(relativePath);
}

/** base64 convenience wrapper around {@link savePastedImageBuffer} — used by
 *  the extension webview path, which receives base64 from the browser. */
export function savePastedImageBase64(
  base64: string,
  fileName: string,
): Promise<string> {
  return savePastedImageBuffer(Buffer.from(base64, 'base64'), fileName);
}
