import { Effect, FileSystem } from 'effect';

import { filterNotNull } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';
import { getPromptFileName } from '@utils/prompt';

import { readNormalizedFile } from './fsDurability';
import { workspaceAbsolutePath } from './workspaceFS';

/** A file successfully read for the `${varName}_FILE`/`${varName}_CONTENT` variable pair. */
interface FileVarValue {
  file: string;
  content: string;
}

/** The prompt XML built from a file list, plus what the read dropped. */
export interface XmlFormatFromFilesResult {
  readonly xml: string | null;
  /** The files that were read, in input order, each with the content the
   *  XML carries, so a caller filling a `*_FILE`/`*_CONTENT` pair from one
   *  of them uses this read rather than reading the file again. */
  readonly readable: FileVarValue[];
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
 * config was saved) is skipped rather than rejecting the whole batch, which
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
    return { xml: null, readable: [], skipped: [] };
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
          document: { file, content },
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
    xml:
      readable.length > 0
        ? readable
            .map(
              ({ file, content }) =>
                `<document name="${getPromptFileName(workspaceRoot, file)}">\n${content}\n</document>`,
            )
            .join('\n')
        : null,
    readable,
    skipped: reads.map((read) => read.skipped).filter(filterNotNull),
  };
});
