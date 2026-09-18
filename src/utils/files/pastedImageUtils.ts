// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Data, Effect, Option } from 'effect';

// Local imports
import { createLog } from '@logger/logUtils';
import { StorageFs } from '@platform/rootedFs';
import { THREE_DAYS_MS } from '@utils/config/constants';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - filesystem
import { PASTED_DIR, isPastedImage } from './pastedImageName';

const log = createLog('pastedImage');

/**
 * The absolute path of a pasted image under `storageRoot` — the form for code
 * that holds a session's roots as data rather than reading a filesystem.
 */
export function pastedImageFullPath(
  storageRoot: string,
  filename: string,
): string {
  return path.join(storageRoot, PASTED_DIR, pastedImageFileName(filename));
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
 * Delete pasted images older than three days. Never fails the save that runs
 * it: the listing and every unlink report their cause on the warn channel, and
 * one bad entry does not stop the rest of the sweep.
 */
const cleanupOldPastedImages = Effect.fn('pastedImage.cleanupOld')(
  function* () {
    const storageFs = yield* StorageFs;
    const cutoff = Date.now() - THREE_DAYS_MS;
    const names = yield* storageFs.readDirectory(PASTED_DIR).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          log.warn(
            `Skipped cleanup of ${PASTED_DIR}: ${toErrorMessage(error)}`,
          );
          return [] as string[];
        }),
      ),
    );
    yield* Effect.forEach(
      names,
      (name) => {
        const filePath = path.join(PASTED_DIR, name);
        return storageFs.stat(filePath).pipe(
          Effect.flatMap((stats) => {
            // The sweep it replaces filtered on the provider's type bits, where
            // a symlink answered for its target and so counted as a file when it
            // pointed at one. The follow here does the same job.
            if (stats.type !== 'File') return Effect.void;
            const mtime = Option.match(stats.mtime, {
              onNone: () => 0,
              onSome: (modified) => modified.getTime(),
            });
            return mtime <= cutoff ? storageFs.remove(filePath) : Effect.void;
          }),
          Effect.catch((error) =>
            Effect.sync(() => {
              log.warn(
                `Could not remove stale file ${filePath}: ${toErrorMessage(error)}`,
              );
            }),
          ),
        );
      },
      { concurrency: 'unbounded', discard: true },
    );
  },
);

/** Why a pasted image could not be persisted, worded as the host shows it so
 *  the caller yields this failure instead of re-minting one of its own. */
export class PastedImageSaveFailed extends Data.TaggedError(
  'PastedImageSaveFailed',
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const saveFailed = (cause: unknown): PastedImageSaveFailed =>
  new PastedImageSaveFailed({
    message: 'The pasted image could not be saved.',
    cause,
  });

/**
 * Persist pasted image bytes into the shared `pasted/` directory of the
 * session's storage view and return the absolute path. Shared by the extension
 * webview host and the CLI so both produce identical on-disk media files that
 * flow through the same `run/mediaInput` path — no duplicated encoding.
 */
export const savePastedImageBuffer = Effect.fn(
  'pastedImage.savePastedImageBuffer',
)(function* (data: Uint8Array, fileName: string) {
  const storageFs = yield* StorageFs;
  const relativePath = yield* Effect.try({
    try: () => path.join(PASTED_DIR, pastedImageFileName(fileName)),
    catch: (cause) => cause,
  });
  yield* storageFs.makeDirectory(PASTED_DIR, { recursive: true });
  yield* storageFs.writeFile(relativePath, data);
  yield* cleanupOldPastedImages();
  return yield* storageFs.resolve(relativePath);
}, Effect.mapError(saveFailed));
