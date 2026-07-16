// Standard library imports
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Platform defaults
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import type { Platform } from '@platform/platform';

import { createFakePlatform } from './FakePlatform';

/**
 * Creates a node-backed `FakePlatform` rooted in a fresh temp directory
 * (`<tempDir>/workspace` and `<tempDir>/storage`), and records the temp
 * directory on `tempDirs` for later cleanup via `cleanupTempDirs`.
 */
export async function createTempDirPlatform(
  prefix: string,
  tempDirs: string[],
): Promise<Platform> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  const workspaceDir = path.join(tempDir, 'workspace');
  const storageRoot = path.join(tempDir, 'storage');
  return createFakePlatform(
    { workspacePath: workspaceDir },
    {
      fs: nodeFilesystem,
      workspace: createNodeWorkspace(() => workspaceDir),
      storage: new WorkspaceStorageProvider(storageRoot, workspaceDir),
      globalState: new MemoryStateStore(),
      workspaceState: new MemoryStateStore(),
    },
  );
}

/** Removes every directory recorded by `createTempDirPlatform` (or pushed manually), then clears the list. */
export async function cleanupTempDirs(tempDirs: string[]): Promise<void> {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}
