import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { StorageProvider } from '@platform/interfaces/storage';

export function workspaceStorageId(workspacePath: string | undefined): string {
  const source = workspacePath?.trim() || 'no-workspace';
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

export class ElectronStorageProvider implements StorageProvider {
  private readonly globalStoragePath: string;
  private readonly workspaceStoragePath: string;

  constructor(userDataPath: string, workspacePath: string | undefined) {
    this.globalStoragePath = join(userDataPath, 'global-storage');
    this.workspaceStoragePath = join(
      userDataPath,
      'workspace-storage',
      workspaceStorageId(workspacePath),
    );
    mkdirSync(this.globalStoragePath, { recursive: true });
    mkdirSync(this.workspaceStoragePath, { recursive: true });
  }

  getStoragePath(): string {
    return this.workspaceStoragePath;
  }

  getGlobalStoragePath(): string {
    return this.globalStoragePath;
  }
}
