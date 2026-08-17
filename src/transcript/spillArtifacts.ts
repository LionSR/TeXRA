// Node imports
import * as path from 'node:path';

// Local imports
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
