// Node imports
import { realpathSync } from 'node:fs';
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
 * The identity a workspace's storage is keyed by, built for storage alone
 * (the storage design's §7): the host's displayed root keeps its spelling.
 * On macOS and Linux it is the native realpath, which answers the name the
 * filesystem holds; the JS realpath keeps the typed case, so on a
 * case-insensitive volume one folder would key two stores. On Windows the
 * JS realpath stays (the native one rewrites a mapped drive to UNC, see
 * `canonicalizePath`) and the key is case-folded. A root that does not
 * resolve (missing, unreadable) keys by its canonical spelling.
 */
function storageIdentity(workspacePath: string): string {
  if (process.platform === 'win32') return workspacePath.toLowerCase();
  try {
    return realpathSync.native(workspacePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(code ?? ''))
      throw error;
    return workspacePath;
  }
}

/**
 * The storage directory name of a workspace. `workspacePath` is the host's
 * canonical workspace root (`canonicalizeWorkspacePath`, decided once where
 * the host reads it); its storage identity keys one folder to one
 * directory whichever case or host spelled it.
 */
function workspaceStorageId(workspacePath: string | undefined): string {
  const trimmed = workspacePath?.trim();
  const source = trimmed ? storageIdentity(trimmed) : 'no-workspace';
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
