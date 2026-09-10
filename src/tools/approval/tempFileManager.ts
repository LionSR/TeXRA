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
 * Why `node:fs/promises` instead of `platform().fs`:
 * the diff editor reads these files outside the platform abstraction, and
 * Extension intentionally bypasses BaseFS normalization so the diff view
 * sees raw bytes. Going through `platform().fs.writeFile` would route
 * through a Uint8Array conversion that's a needless detour for this use,
 * and `platform()` may not be initialized in every host that wants to
 * stage diff inputs.
 */

import { unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { Effect } from 'effect';

import { debug } from '@logger/logUtils';
import { generateShortId } from '@utils/core';

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
      Effect.sync(() => {
        debug('approval.tempFiles', `Failed to unlink temp file ${target}`, {
          data: error,
        });
      }),
    ),
  );

/**
 * File names use a per-side random ID so reusing a shared directory across
 * concurrent requests cannot collide.
 */
export const writeApprovalTempFiles = Effect.fn('writeApprovalTempFiles')(
  function* (
    input: WriteApprovalTempFilesInput,
  ): Effect.fn.Return<ApprovalTempFiles, unknown> {
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
        Effect.tryPromise({
          try: () => writeFile(originalPath, originalContent, 'utf8'),
          catch: (error) => error,
        }),
        Effect.tryPromise({
          try: () => writeFile(proposedPath, proposedContent, 'utf8'),
          catch: (error) => error,
        }),
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
