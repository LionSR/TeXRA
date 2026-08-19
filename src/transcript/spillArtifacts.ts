import * as path from 'node:path';

import { isFileNotFoundError } from '@common/errors';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { ExecutionIdSchema } from '@shared/schemas';
import { getPathSegments } from '@utils/core/pathCore';
import { StorageFS } from '@utils/files/storageFS';

/**
 * Resolve a recorder-owned spill path without accepting arbitrary storage
 * paths from a persisted transcript. Spill artifacts are always terminal text
 * files under one execution's `toolOutput` directory.
 */
export function resolveTranscriptSpillPath(
  spillPath: string,
): string | undefined {
  const posixPath = spillPath.replaceAll('\\', '/');
  const segments = getPathSegments(posixPath);
  if (
    segments.length !== 4 ||
    segments[0] !== WORKSPACE_STORAGE_LAYOUT.runs ||
    segments[2] !== 'toolOutput' ||
    path.posix.isAbsolute(posixPath) ||
    path.win32.isAbsolute(spillPath) ||
    segments.includes('..') ||
    !segments[3]?.endsWith('.txt') ||
    !ExecutionIdSchema.safeParse(segments[1]).success
  ) {
    return undefined;
  }
  return segments.join('/');
}

/** Read one validated recorder-owned spill artifact on demand. */
export async function readTranscriptSpill(
  spillPath: string,
): Promise<string | undefined> {
  const resolved = resolveTranscriptSpillPath(spillPath);
  if (!resolved) return undefined;
  try {
    return await StorageFS.read(resolved);
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  }
}

/** Resolve one existing spill to an absolute path for a native host opener. */
export async function findTranscriptSpillFile(
  spillPath: string,
): Promise<string | undefined> {
  const resolved = resolveTranscriptSpillPath(spillPath);
  if (!resolved || !(await StorageFS.isFile(resolved))) return undefined;
  return StorageFS.fullPath(resolved);
}

/**
 * What the two native hosts say when {@link findTranscriptSpillFile} finds
 * nothing. Both the progress view's "open full output" action and the desktop
 * task shell's run the same lookup against the same store; a run whose
 * artifacts were reaped is one fact, so it gets one sentence.
 */
export const SPILL_ARTIFACT_DELETED_MESSAGE =
  'Full output is unavailable because this run artifact was deleted.';

/** Companion for the failure path — the lookup or the open itself threw. */
export function spillArtifactOpenFailedMessage(reason: string): string {
  return `Full output could not be opened: ${reason}`;
}
