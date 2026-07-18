// Standard library imports
import * as path from 'node:path';

// Local imports
import { generateShortId } from '@utils/core';
import { THREE_DAYS_MS } from '@utils/config/constants';
import { StorageFS } from './storageFS';

export const PASTED_DIR = 'pasted';

const PASTED_PREFIX = 'pasted_';

/** Generate a pasted-image filename: `pasted_<timestamp>_<rand>.<ext>`. */
export function generatePastedImageName(ext: string): string {
  return `${PASTED_PREFIX}${Date.now()}_${generateShortId(6)}.${ext}`;
}

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
  return StorageFS.fullPath(
    path.join(PASTED_DIR, pastedImageFileName(filename)),
  );
}

/**
 * Validate a pasted-image filename received at a trust boundary. Webviews send
 * filenames over IPC, so reject path separators, absolute paths, empty names,
 * and non-TeXRA pasted-image names instead of silently normalizing them.
 */
export function pastedImageFileName(fileName: string): string {
  if (
    !fileName ||
    fileName.includes('\0') ||
    path.isAbsolute(fileName) ||
    path.win32.isAbsolute(fileName) ||
    path.posix.basename(fileName) !== fileName ||
    path.win32.basename(fileName) !== fileName ||
    !isPastedImage(fileName)
  ) {
    throw new Error('Invalid pasted image filename.');
  }
  return fileName;
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
  const safeName = pastedImageFileName(fileName);
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
