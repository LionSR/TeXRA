// Node imports
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Local imports - platform
import type { StorageProvider } from '../interfaces/storage';

export const GLOBAL_STORAGE_DIR = 'global-storage';
export const WORKSPACE_STORAGE_DIR = 'workspace-storage';

type WorkspacePathSource = string | undefined | (() => string | undefined);

export function workspaceStorageId(workspacePath: string | undefined): string {
  const source = workspacePath?.trim() || 'no-workspace';
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
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
    const storagePath = resolveWorkspaceStoragePath(
      this.storageRoot,
      this.getWorkspacePath(),
    );
    mkdirSync(storagePath, { recursive: true });
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
