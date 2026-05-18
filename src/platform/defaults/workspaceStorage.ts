// Node imports
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// Local imports - platform
import type { StorageProvider } from '../interfaces/storage';

export const GLOBAL_STORAGE_DIR = 'global-storage';
export const WORKSPACE_STORAGE_DIR = 'workspace-storage';

type WorkspacePathSource = string | undefined | (() => string | undefined);

function workspaceStorageHash(source: string, length: number): string {
  return createHash('sha256').update(source).digest('hex').slice(0, length);
}

function legacyWorkspaceStorageId(workspacePath: string | undefined): string {
  const source = workspacePath?.trim() || 'no-workspace';
  return workspaceStorageHash(source, 16);
}

function sanitizeWorkspaceBasename(workspacePath: string): string {
  return (
    basename(workspacePath)
      .replaceAll(/[^A-Za-z0-9._-]/g, '-')
      .replaceAll(/-+/g, '-')
      .replaceAll(/^-|-$/g, '') || 'workspace'
  );
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
  return join(storageRoot, GLOBAL_STORAGE_DIR);
}

export function resolveWorkspaceStoragePath(
  storageRoot: string,
  workspacePath: string | undefined,
): string {
  return join(
    storageRoot,
    WORKSPACE_STORAGE_DIR,
    workspaceStorageId(workspacePath),
  );
}

function resolveLegacyWorkspaceStoragePath(
  storageRoot: string,
  workspacePath: string | undefined,
): string {
  return join(
    storageRoot,
    WORKSPACE_STORAGE_DIR,
    legacyWorkspaceStorageId(workspacePath),
  );
}

function writeWorkspaceSidecar(
  storagePath: string,
  workspacePath: string | undefined,
): void {
  const sidecarPath = join(storagePath, '_workspace.json');
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
  renameSync(legacyPath, currentPath);
}

export class WorkspaceStorageProvider implements StorageProvider {
  private readonly getWorkspacePath: () => string | undefined;

  constructor(
    private readonly storageRoot: string,
    workspacePath: WorkspacePathSource,
  ) {
    this.getWorkspacePath =
      typeof workspacePath === 'function' ? workspacePath : () => workspacePath;
  }

  getStoragePath(): string {
    const workspacePath = this.getWorkspacePath();
    migrateLegacyWorkspaceStorage(this.storageRoot, workspacePath);
    const storagePath = resolveWorkspaceStoragePath(
      this.storageRoot,
      workspacePath,
    );
    mkdirSync(storagePath, { recursive: true });
    writeWorkspaceSidecar(storagePath, workspacePath);
    return storagePath;
  }

  getGlobalStoragePath(): string {
    const storagePath = resolveGlobalStoragePath(this.storageRoot);
    mkdirSync(storagePath, { recursive: true });
    return storagePath;
  }
}

export function createWorkspaceStorageProvider(
  storageRoot: string,
  workspacePath: WorkspacePathSource,
): StorageProvider {
  return new WorkspaceStorageProvider(storageRoot, workspacePath);
}
