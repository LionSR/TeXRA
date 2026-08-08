// Node imports
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, posix, relative } from 'node:path';

import {
  WORKSPACE_SIDECAR_FILE,
  WORKSPACE_STORAGE_LAYOUT,
} from '@common/storage/storageLayout';
import * as logger from '@logger/logUtils';
import { isPathWithin } from '@utils/core/pathCore';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { sanitizePathSegment } from '@utils/text/sanitizePathSegment';

// Local imports - platform
import type { StorageProvider } from '../interfaces';

const STORAGE_LAYOUT = {
  global: 'global-storage',
  workspace: 'workspace-storage',
} as const;

export const MEMORY_STORAGE_DIR = WORKSPACE_STORAGE_LAYOUT.memory;
export const RUNS_STORAGE_DIR = WORKSPACE_STORAGE_LAYOUT.runs;
export const WORKSPACE_STORAGE_COLLECTIONS_MERGED_PER_CHILD = [
  RUNS_STORAGE_DIR,
  WORKSPACE_STORAGE_LAYOUT.executionLeases,
  WORKSPACE_STORAGE_LAYOUT.legacyRuns,
  WORKSPACE_STORAGE_LAYOUT.streamData,
  WORKSPACE_STORAGE_LAYOUT.streamLogs,
  MEMORY_STORAGE_DIR,
] as const;

type WorkspacePathSource = string | undefined | (() => string | undefined);

function workspaceStorageHash(source: string, length: number): string {
  return createHash('sha256').update(source).digest('hex').slice(0, length);
}

function legacyWorkspaceStorageId(workspacePath: string | undefined): string {
  const source = workspacePath?.trim() || 'no-workspace';
  return workspaceStorageHash(source, 16);
}

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
  return `${stem}-${workspaceStorageHash(source, 8)}`;
}

export function resolveGlobalStoragePath(storageRoot: string): string {
  return join(storageRoot, STORAGE_LAYOUT.global);
}

export function resolveWorkspaceStoragePath(
  storageRoot: string,
  workspacePath: string | undefined,
): string {
  return join(
    storageRoot,
    STORAGE_LAYOUT.workspace,
    workspaceStorageId(workspacePath),
  );
}

export function resolveMemoryStoragePath(
  storagePath: string = MEMORY_STORAGE_DIR,
): string {
  const normalized = posix.normalize(storagePath);
  if (!isPathWithin(MEMORY_STORAGE_DIR, normalized)) {
    throw new Error(`Invalid memory path: ${storagePath}`);
  }
  return posix.join(
    MEMORY_STORAGE_DIR,
    posix.relative(MEMORY_STORAGE_DIR, normalized),
  );
}

export function resolveRunStoragePath(...segments: string[]): string {
  return posix.join(RUNS_STORAGE_DIR, ...segments);
}

export function resolveRunOriginalSnapshotPath(
  executionId: string,
  workspaceRelativePath: string,
): string {
  return resolveRunStoragePath(
    executionId,
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

function resolveLegacyWorkspaceStoragePath(
  storageRoot: string,
  workspacePath: string | undefined,
): string {
  return join(
    storageRoot,
    STORAGE_LAYOUT.workspace,
    legacyWorkspaceStorageId(workspacePath),
  );
}

function writeWorkspaceSidecar(
  storagePath: string,
  workspacePath: string | undefined,
): void {
  const sidecarPath = join(storagePath, WORKSPACE_SIDECAR_FILE);
  if (existsSync(sidecarPath)) return;

  writeFileSync(
    sidecarPath,
    `${JSON.stringify(
      {
        path: workspacePath?.trim() || null,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function migrateLegacyWorkspaceStorage(
  storageRoot: string,
  workspacePath: string | undefined,
): void {
  const currentPath = resolveWorkspaceStoragePath(storageRoot, workspacePath);
  const legacyPath = resolveLegacyWorkspaceStoragePath(
    storageRoot,
    workspacePath,
  );

  if (currentPath === legacyPath) return;
  if (!existsSync(legacyPath) || existsSync(currentPath)) return;
  try {
    renameSync(legacyPath, currentPath);
  } catch (error) {
    logger.warn(
      'WorkspaceStorage',
      `Could not migrate legacy workspace storage; continuing with the current storage directory. Cause: ${toErrorMessage(error)}`,
    );
  }
}

export class WorkspaceStorageProvider implements StorageProvider {
  private readonly getWorkspacePath: () => string | undefined;
  private activeWorkspacePath: string | undefined;
  private readonly initializedStoragePaths = new Set<string>();
  private workspaceChangeRollback:
    { readonly workspacePath: string | undefined } | undefined;

  constructor(
    private readonly storageRoot: string,
    workspacePath: WorkspacePathSource,
  ) {
    this.getWorkspacePath =
      typeof workspacePath === 'function' ? workspacePath : () => workspacePath;
    this.activeWorkspacePath = this.getWorkspacePath();
  }

  private storagePathFor(workspacePath: string | undefined): string {
    return resolveWorkspaceStoragePath(this.storageRoot, workspacePath);
  }

  getStoragePath(): string {
    const workspacePath = this.activeWorkspacePath;
    const storagePath = this.storagePathFor(workspacePath);
    if (this.initializedStoragePaths.has(storagePath)) return storagePath;

    // The legacy rename must precede directory creation because it stops once
    // the current directory exists.
    migrateLegacyWorkspaceStorage(this.storageRoot, workspacePath);
    mkdirSync(storagePath, { recursive: true });
    writeWorkspaceSidecar(storagePath, workspacePath);
    this.initializedStoragePaths.add(storagePath);
    return storagePath;
  }

  private resolveTargetWorkspacePath(target?: {
    workspacePath: string | undefined;
  }): string | undefined {
    return target ? target.workspacePath : this.getWorkspacePath();
  }

  hasPendingWorkspaceStorageChange(target?: {
    workspacePath: string | undefined;
  }): boolean {
    const targetWorkspacePath = this.resolveTargetWorkspacePath(target);
    return (
      this.storagePathFor(this.activeWorkspacePath) !==
      this.storagePathFor(targetWorkspacePath)
    );
  }

  commitWorkspaceStorageChange(target?: {
    workspacePath: string | undefined;
  }): boolean {
    const targetWorkspacePath = this.resolveTargetWorkspacePath(target);
    if (
      this.storagePathFor(targetWorkspacePath) ===
      this.storagePathFor(this.activeWorkspacePath)
    ) {
      return false;
    }
    if (this.workspaceChangeRollback) {
      throw new Error('A workspace storage change is already in progress.');
    }
    this.workspaceChangeRollback = {
      workspacePath: this.activeWorkspacePath,
    };
    this.activeWorkspacePath = targetWorkspacePath;
    return true;
  }

  finalizeWorkspaceStorageChange(): void {
    this.workspaceChangeRollback = undefined;
  }

  rollbackWorkspaceStorageChange(): boolean {
    if (!this.workspaceChangeRollback) return false;
    this.activeWorkspacePath = this.workspaceChangeRollback.workspacePath;
    this.workspaceChangeRollback = undefined;
    return true;
  }

  getGlobalStoragePath(): string {
    const storagePath = resolveGlobalStoragePath(this.storageRoot);
    mkdirSync(storagePath, { recursive: true });
    return storagePath;
  }
}
