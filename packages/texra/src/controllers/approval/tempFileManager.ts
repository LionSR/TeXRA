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
 * raw bytes through the `FileSystem` service its run provides; the approval
 * controller runs the resulting Effect on its fiber.
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import { Effect, FileSystem } from 'effect';

import { withLogChannel } from '@texra-ai/harness/plugins';
import { removeBestEffort } from '@texra/common/files/removeBestEffort';
import { hostFailed } from '@texra/controllers/session/hostCallFailure';
import type { HostFailed } from '@texra/hosts/uiHosts';

const CHANNEL = 'approval.tempFiles';

/** Write one staged diff side; a failure is the host's, named by the side,
 *  like the directory the host created for it. */
const writeSide = (
  fs: FileSystem.FileSystem,
  side: 'original' | 'proposed',
  filePath: string,
  content: string,
): Effect.Effect<void, HostFailed> =>
  fs
    .writeFileString(filePath, content)
    .pipe(
      Effect.mapError((cause) => hostFailed(`approval.write.${side}`, cause)),
    );

export interface ApprovalTempFiles {
  readonly originalPath: string;
  readonly proposedPath: string;
  /**
   * Removes the two written files. Idempotent and silent on ENOENT:
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

/**
 * File names use a per-side random ID so reusing a shared directory across
 * concurrent requests cannot collide.
 */
export const writeApprovalTempFiles = Effect.fn('writeApprovalTempFiles')(
  function* (
    input: WriteApprovalTempFilesInput,
  ): Effect.fn.Return<ApprovalTempFiles, HostFailed, FileSystem.FileSystem> {
    const fs = yield* FileSystem.FileSystem;
    const { directory, targetPath, originalContent, proposedContent } = input;
    const ext = path.extname(targetPath) || '.txt';
    const originalPath = path.join(directory, `${randomUUID()}-original${ext}`);
    const proposedPath = path.join(directory, `${randomUUID()}-proposed${ext}`);

    const cleanup = removeBestEffort(
      fs,
      [originalPath, proposedPath],
      'temp file',
    ).pipe(Effect.asVoid, withLogChannel(CHANNEL));
    // Both sides start together and the first failure fails the stage, as the
    // `Promise.all` here did; a staged pair nobody can read is not a partial
    // success to salvage, so the side that was written is removed with it.
    yield* Effect.all(
      [
        writeSide(fs, 'original', originalPath, originalContent),
        writeSide(fs, 'proposed', proposedPath, proposedContent),
      ],
      { concurrency: 'unbounded' },
    ).pipe(Effect.onError(() => cleanup));

    return { originalPath, proposedPath, cleanup };
  },
);
