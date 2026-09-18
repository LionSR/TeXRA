// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Data, Effect } from 'effect';

// Local imports
import { THREE_DAYS_MS } from '@utils/config/constants';

// Local imports - filesystem
import { PASTED_DIR, isPastedImage } from './pastedImageName';
import { StorageFS } from './storageFS';

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
 * `run/mediaInput` path — no duplicated encoding.
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

/** Why a pasted image could not be persisted, worded as the host shows it so
 *  the caller yields this failure instead of re-minting one of its own. */
export class PastedImageSaveFailed extends Data.TaggedError(
  'PastedImageSaveFailed',
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/**
 * base64 form of {@link savePastedImageBuffer} — used by the extension
 * webview path, which receives base64 from the browser. The write still goes
 * through `StorageFS`'s ambient-rooted statics, so the one promise boundary
 * is wrapped here rather than at the request handler; moving the write onto
 * the rooted `StorageFs` view waits on #12421, which owes the three-day
 * cleanup an equivalent.
 */
export function savePastedImageBase64(
  base64: string,
  fileName: string,
): Effect.Effect<string, PastedImageSaveFailed> {
  return Effect.tryPromise({
    try: () => savePastedImageBuffer(Buffer.from(base64, 'base64'), fileName),
    catch: (cause) =>
      new PastedImageSaveFailed({
        message: 'The pasted image could not be saved.',
        cause,
      }),
  });
}
