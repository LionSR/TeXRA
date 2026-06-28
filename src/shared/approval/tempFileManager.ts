/**
 * Shared temp-file manager for tool edit approval flows.
 *
 * Desktop and Extension both materialize the original and proposed file
 * contents on disk so a host-specific diff view can read them. This module
 * owns the file naming and write/cleanup mechanics; each host owns its
 * directory-lifecycle strategy.
 */

import { unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { nanoid } from 'nanoid';

import { debug } from '@logger/logUtils';

export interface ApprovalTempFiles {
  readonly originalPath: string;
  readonly proposedPath: string;
  /**
   * Removes the two written files. Idempotent and silent on ENOENT.
   */
  readonly cleanup: () => Promise<void>;
}

export interface WriteApprovalTempFilesInput {
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
export async function writeApprovalTempFiles(
  input: WriteApprovalTempFilesInput,
): Promise<ApprovalTempFiles> {
  const { directory, targetPath, originalContent, proposedContent } = input;
  const ext = path.extname(targetPath) || '.txt';
  const originalPath = path.join(directory, `${nanoid()}-original${ext}`);
  const proposedPath = path.join(directory, `${nanoid()}-proposed${ext}`);

  await Promise.all([
    writeFile(originalPath, originalContent, 'utf8'),
    writeFile(proposedPath, proposedContent, 'utf8'),
  ]);

  return {
    originalPath,
    proposedPath,
    cleanup: async () => {
      const swallowUnlink = (target: string) => (error: unknown) => {
        // Best-effort cleanup; ENOENT/already-removed is expected and benign.
        debug('approval.tempFiles', `Failed to unlink temp file ${target}`, {
          data: error,
        });
      };
      await Promise.all([
        unlink(originalPath).catch(swallowUnlink(originalPath)),
        unlink(proposedPath).catch(swallowUnlink(proposedPath)),
      ]);
    },
  };
}
