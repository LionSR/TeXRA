import { Effect, FileSystem } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { filterNotNull } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { getPromptFileName } from '@utils/prompt';

import { readNormalizedFile } from './fsDurability';
import { workspaceAbsolutePath } from './workspaceFS';

const CHANNEL = 'VarsUtils';

/** A file successfully read for the `${varName}_FILE`/`${varName}_CONTENT` variable pair. */
export interface FileVarValue {
  file: string;
  content: string;
}

/**
 * Reads a file for the `${varName}_FILE`/`${varName}_CONTENT` variable pair.
 * Returns `null` on read failure; the caller decides how to name and store
 * the pair, so this stays a plain read rather than a stringly-keyed write
 * into an arbitrary vars object.
 *
 * `workspaceRoot` is the root a relative `filePath` resolves against, held by
 * the caller as data rather than read from the calling fiber's ambient roots.
 * An already-absolute `filePath` passes through it untouched, so a caller that
 * has resolved its own path can hand in `undefined`.
 */
export const setVarFromFile = Effect.fn('varsUtils.setVarFromFile')(function* (
  filePath: string,
  varName: string,
  workspaceRoot: string | undefined,
): Effect.fn.Return<FileVarValue | null, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  // The resolution is inside the Effect, not an argument evaluated before it:
  // `workspaceAbsolutePath` throws for a relative path with no workspace root
  // open, and outside the Effect that throw is a defect the `Effect.catch`
  // below never sees (#12803).
  return yield* Effect.try({
    try: () => workspaceAbsolutePath(workspaceRoot, filePath),
    catch: ensureError,
  }).pipe(
    Effect.flatMap((absolute) => readNormalizedFile(fs, absolute)),
    Effect.map((content) => ({ file: filePath, content })),
    Effect.catch((error) =>
      // The variable is simply absent from the prompt after this, so a
      // mistyped path and a permission error must not read like a real
      // absence.
      Effect.logWarning(
        `Failed to read ${varName} from file ${filePath}: ${toErrorMessage(error)}`,
      ).pipe(withLogChannel(CHANNEL), Effect.annotateLogs({ data: error }), Effect.as(null)),
    ),
  );
});

/** The prompt XML built from a file list, plus what the read dropped. */
export interface XmlFormatFromFilesResult {
  readonly xml: string | null;
  readonly readableFiles: string[];
  /**
   * Files dropped from the prompt because they could not be read. Order is
   * unspecified — the reads settle concurrently — so do not build on it; each
   * entry names its own file.
   */
  readonly skipped: ReadonlyArray<{ file: string; reason: string }>;
}

/**
 * Get XML formatted string from multiple files
 *
 * Best-effort: a file that cannot be read (moved, renamed, or deleted since the
 * config was saved) is skipped rather than rejecting the whole batch. This
 * mirrors {@link setVarFromFile}, which already tolerates missing files, and
 * keeps prompt-var assembly from hard-failing an agent launch/resume when an
 * input no longer exists on disk. The skip is reported back in `skipped` so the
 * caller can surface it on the run's own channel — a module logger here would
 * drop the reason outside the run that lost the file.
 *
 * @param workspaceRoot Root a relative entry resolves against, held as data
 * @param files List of file paths
 * @returns XML formatted string of the readable files, or null if none are readable
 */
export const getXmlFormatFromReadableFiles = Effect.fn(
  'varsUtils.getXmlFormatFromReadableFiles',
)(function* (
  workspaceRoot: string | undefined,
  files: string[],
): Effect.fn.Return<XmlFormatFromFilesResult, never, FileSystem.FileSystem> {
  if (files.length === 0) {
    return { xml: null, readableFiles: [], skipped: [] };
  }

  const fs = yield* FileSystem.FileSystem;
  const reads = yield* Effect.forEach(
    files,
    (file) =>
      // Resolved inside the Effect: with no workspace root open a relative
      // entry makes `workspaceAbsolutePath` throw, and as an argument that
      // throw escaped the per-file `Effect.catch` as a defect and failed the
      // whole batch instead of skipping the one file (#12803).
      Effect.try({
        try: () => workspaceAbsolutePath(workspaceRoot, file),
        catch: ensureError,
      }).pipe(
        Effect.flatMap((absolute) => readNormalizedFile(fs, absolute)),
        Effect.map((content) => ({
          document: {
            file,
            xml: `<document name="${getPromptFileName(workspaceRoot, file)}">\n${content}\n</document>`,
          },
          skipped: null,
        })),
        Effect.catch((err) =>
          Effect.succeed({
            document: null,
            skipped: { file, reason: String(err) },
          }),
        ),
      ),
    { concurrency: 'unbounded' },
  );

  const readable = reads.map((read) => read.document).filter(filterNotNull);
  return {
    xml: readable.length > 0 ? readable.map((doc) => doc.xml).join('\n') : null,
    readableFiles: readable.map((doc) => doc.file),
    skipped: reads.map((read) => read.skipped).filter(filterNotNull),
  };
});
