/**
 * Shared temp-file manager for tool edit approval flows.
 *
 * Desktop and Extension both materialize the original and proposed file
 * contents on disk so a host-specific diff view (Electron IPC, vscode.diff)
 * can read them. This module owns the file naming and write/cleanup
 * mechanics; each host owns its directory-lifecycle strategy:
 *
 *   - Desktop creates a fresh per-request directory via `mkdtemp` and
 *     deletes the whole directory at the end.
 *   - Extension reuses a persistent storage directory and unlinks the
 *     individual files (via the returned `cleanup`) once done.
 *
 * The diff editor reads these files itself, so the host stages the caller's
 * raw bytes through Node's filesystem. Promise rejections are tagged at this
 * boundary; the approval controller runs the resulting Effect on its fiber.
 */

import { unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { Data, Effect } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { generateShortId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'approval.tempFiles';

/** A staged diff side could not be written to the host filesystem. */
class ApprovalTempWriteFailed extends Data.TaggedError(
  'ApprovalTempWriteFailed',
)<{
  readonly side: 'original' | 'proposed';
  readonly message: string;
  readonly cause: unknown;
}> {}

const writeSide = (
  side: 'original' | 'proposed',
  filePath: string,
  content: string,
): Effect.Effect<void, ApprovalTempWriteFailed> =>
  Effect.tryPromise({
    try: () => writeFile(filePath, content, 'utf8'),
    catch: (cause) =>
      new ApprovalTempWriteFailed({
        side,
        message: toErrorMessage(cause),
        cause,
      }),
  });

export interface ApprovalTempFiles {
  readonly originalPath: string;
  readonly proposedPath: string;
  /**
   * Removes the two written files. Idempotent and silent on ENOENT —
   * callers that manage an enclosing directory (e.g. Desktop's mkdtemp)
   * can still rm-rf the dir afterwards without seeing errors here.
   */
  readonly cleanup: Effect.Effect<void>;
}

interface WriteApprovalTempFilesInput {
  readonly directory: string;
  /** Seeds the file extension shown in the diff view; not a write target. */
  readonly targetPath: string;
  readonly originalContent: string;
  readonly proposedContent: string;
}

/** Best-effort temp cleanup; ENOENT/already-removed is expected and benign. */
const removeTempFile = (target: string): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => unlink(target),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      Effect.logDebug(`Failed to unlink temp file ${target}`).pipe(
        Effect.annotateLogs({ data: error }),
        withLogChannel(CHANNEL),
      ),
    ),
  );

/**
 * File names use a per-side random ID so reusing a shared directory across
 * concurrent requests cannot collide.
 */
export const writeApprovalTempFiles = Effect.fn('writeApprovalTempFiles')(
  function* (
    input: WriteApprovalTempFilesInput,
  ): Effect.fn.Return<ApprovalTempFiles, ApprovalTempWriteFailed> {
    const { directory, targetPath, originalContent, proposedContent } = input;
    const ext = path.extname(targetPath) || '.txt';
    const originalPath = path.join(
      directory,
      `${generateShortId()}-original${ext}`,
    );
    const proposedPath = path.join(
      directory,
      `${generateShortId()}-proposed${ext}`,
    );

    // Both sides start together and the first failure fails the stage, as the
    // `Promise.all` here did; a staged pair nobody can read is not a partial
    // success to salvage.
    yield* Effect.all(
      [
        writeSide('original', originalPath, originalContent),
        writeSide('proposed', proposedPath, proposedContent),
      ],
      { concurrency: 'unbounded' },
    );

    return {
      originalPath,
      proposedPath,
      cleanup: Effect.all(
        [removeTempFile(originalPath), removeTempFile(proposedPath)],
        { concurrency: 'unbounded', discard: true },
      ),
    };
  },
);
