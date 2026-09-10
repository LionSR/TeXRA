// Node imports
import { mkdirSync } from 'node:fs';
import { basename, join, posix, relative } from 'node:path';

import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { truncatedHexId } from '@utils/core/idHash';
import { isPathWithin } from '@utils/core/pathCore';
import { sanitizePathSegment } from '@utils/text/sanitizePathSegment';

// Local imports - platform
import type { StorageProvider } from '../interfaces';

const STORAGE_LAYOUT = {
  global: 'global-storage',
  workspace: 'workspace-storage',
} as const;

export const MEMORY_STORAGE_DIR = WORKSPACE_STORAGE_LAYOUT.memory;
export const RUNS_STORAGE_DIR = WORKSPACE_STORAGE_LAYOUT.runs;

function sanitizeWorkspaceBasename(workspacePath: string): string {
  return sanitizePathSegment(basename(workspacePath), {
    invalidCharPattern: /[^A-Za-z0-9._-]/g,
    replacement: '-',
    collapseRepeats: true,
    trimReplacement: true,
    fallback: 'workspace',
  });
}

export function workspaceStorageId(workspacePath: string | undefined): string {
  const source = workspacePath?.trim() || 'no-workspace';
  const stem =
    source === 'no-workspace'
      ? 'no-workspace'
      : sanitizeWorkspaceBasename(source);
  return `${stem}-${truncatedHexId(source, 8)}`;
}

/**
 * Storage-format namespace. Bumped to `v2` for 1.0: the session database's
 * row shape changed incompatibly (one `run` aggregate, renamed row types, a
 * different partial index), and a 1.0 host must never open the `v1` file a
 * 0.x host wrote. No migration and no legacy reader: the `v1` tree is simply
 * left where it is.
 */
const STORAGE_NAMESPACE = 'v2';

export function resolveGlobalStoragePath(storageRoot: string): string {
  return join(storageRoot, STORAGE_NAMESPACE, STORAGE_LAYOUT.global);
}

export function resolveWorkspaceStoragePath(
  storageRoot: string,
  workspacePath: string | undefined,
): string {
  return join(
    storageRoot,
    STORAGE_NAMESPACE,
    STORAGE_LAYOUT.workspace,
    workspaceStorageId(workspacePath),
  );
}

export function resolveMemoryStoragePath(
  storagePath: string = MEMORY_STORAGE_DIR,
): string {
  const normalized = posix.normalize(storagePath.replaceAll('\\', '/'));
  if (
    normalized !== MEMORY_STORAGE_DIR &&
    !normalized.startsWith(`${MEMORY_STORAGE_DIR}/`)
  ) {
    throw new Error(`Invalid memory path: ${storagePath}`);
  }
  return normalized;
}

export function resolveRunStoragePath(...segments: string[]): string {
  return posix.join(RUNS_STORAGE_DIR, ...segments);
}

export function resolveRunOriginalSnapshotPath(
  runId: string,
  workspaceRelativePath: string,
): string {
  return resolveRunStoragePath(
    runId,
    WORKSPACE_STORAGE_LAYOUT.original,
    workspaceRelativePath,
  );
}

export function resolveRunStorageRelativePath(
  absolutePath: string,
  runDirectory: string,
): string | undefined {
  if (!isPathWithin(runDirectory, absolutePath)) return undefined;
  return (
    relative(runDirectory, absolutePath).replaceAll('\\', '/') || undefined
  );
}

export class WorkspaceStorageProvider implements StorageProvider {
  /**
   * The workspace root is pinned once, at construction. A host whose source
   * can move (VS Code's first workspace folder, Electron's window) answers a
   * move by restarting, exactly as the desktop app and the CLI do, so the
   * storage root never changes under live runs.
   */
  private readonly activeWorkspacePath: string | undefined;
  private readonly initializedStoragePaths = new Set<string>();

  constructor(
    private readonly storageRoot: string,
    workspacePath: string | undefined,
  ) {
    this.activeWorkspacePath = workspacePath;
  }

  getStoragePath(): string {
    const workspacePath = this.activeWorkspacePath;
    const storagePath = resolveWorkspaceStoragePath(
      this.storageRoot,
      workspacePath,
    );
    if (this.initializedStoragePaths.has(storagePath)) return storagePath;

    mkdirSync(storagePath, { recursive: true });
    this.initializedStoragePaths.add(storagePath);
    return storagePath;
  }

  getGlobalStoragePath(): string {
    const storagePath = resolveGlobalStoragePath(this.storageRoot);
    mkdirSync(storagePath, { recursive: true });
    return storagePath;
  }
}
