// Node imports
import { basename, join, posix } from 'node:path';

import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { normalizeFilePath } from '@utils/core';
import { truncatedHexId } from '@utils/core/idHash';
import { sanitizePathSegment } from '@utils/text/sanitizePathSegment';

const STORAGE_LAYOUT = {
  global: 'global-storage',
  workspace: 'workspace-storage',
} as const;

function sanitizeWorkspaceBasename(workspacePath: string): string {
  return sanitizePathSegment(basename(workspacePath), {
    invalidCharPattern: /[^A-Za-z0-9._-]/g,
    replacement: '-',
    collapseRepeats: true,
    trimReplacement: true,
    fallback: 'workspace',
  });
}

/**
 * The storage directory name of a workspace. `workspacePath` is the host's
 * canonical workspace root (`canonicalizeWorkspacePath`, decided once where
 * the host reads it), so every host keys one workspace to one directory.
 */
function workspaceStorageId(workspacePath: string | undefined): string {
  const source = workspacePath?.trim() || 'no-workspace';
  const stem =
    source === 'no-workspace'
      ? 'no-workspace'
      : sanitizeWorkspaceBasename(source);
  return `${stem}-${truncatedHexId(source, 8)}`;
}

/*
 * Pure path calculators: nothing here creates a directory. The stores that
 * live under these paths (the session database, `JsonStore`) create their own
 * directory when they first write.
 */
export function resolveGlobalStoragePath(storageRoot: string): string {
  return join(storageRoot, 'v1', STORAGE_LAYOUT.global);
}

export function resolveWorkspaceStoragePath(
  storageRoot: string,
  workspacePath: string | undefined,
): string {
  return join(
    storageRoot,
    'v1',
    STORAGE_LAYOUT.workspace,
    workspaceStorageId(workspacePath),
  );
}

export function resolveMemoryStoragePath(
  storagePath: string = WORKSPACE_STORAGE_LAYOUT.memory,
): string {
  const normalized = posix.normalize(normalizeFilePath(storagePath));
  if (
    normalized !== WORKSPACE_STORAGE_LAYOUT.memory &&
    !normalized.startsWith(`${WORKSPACE_STORAGE_LAYOUT.memory}/`)
  ) {
    throw new Error(`Invalid memory path: ${storagePath}`);
  }
  return normalized;
}
