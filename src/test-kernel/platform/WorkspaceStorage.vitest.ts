// Node imports
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports - platform
import { WORKSPACE_SIDECAR_FILE } from '@common/storage/storageLayout';
import { createNodeStorageProvider } from '@platform/defaults/nodeStorage';
import {
  LEGACY_RUNS_STORAGE_DIR,
  MEMORY_STORAGE_DIR,
  resolveExistingRunStoragePath,
  WorkspaceStorageProvider,
  resolveGlobalStoragePath,
  resolveLegacyRunStoragePath,
  resolveMemoryStoragePath,
  resolveRunOriginalSnapshotPath,
  resolveRunStoragePath,
  resolveWorkspaceStoragePath,
  RUNS_STORAGE_DIR,
  workspaceStorageId,
} from '@platform/defaults/workspaceStorage';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readWorkspaceMarker(
  storagePath: string,
): Promise<{ path: string }> {
  const marker = await readFile(
    join(storagePath, WORKSPACE_SIDECAR_FILE),
    'utf8',
  );
  return JSON.parse(marker) as { path: string };
}

describe('workspace storage defaults', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await cleanupTempDirs(tempDirs);
  });

  it('computes a stable workspace storage identity', () => {
    expect(workspaceStorageId('/workspace/a')).toMatch(/^a-[0-9a-f]{8}$/);
    expect(workspaceStorageId('/workspace/a')).toBe(
      workspaceStorageId('  /workspace/a  '),
    );
    expect(workspaceStorageId('/workspace/a')).not.toBe(
      workspaceStorageId('/workspace/b'),
    );
    expect(workspaceStorageId('/workspace/b')).toMatch(/^b-[0-9a-f]{8}$/);
    expect(workspaceStorageId(undefined)).toBe(workspaceStorageId(''));
    expect(workspaceStorageId(undefined)).toMatch(/^no-workspace-[0-9a-f]{8}$/);
  });

  it('snapshots global, workspace, memory, and run storage layout paths', async () => {
    const root = await makeTempDir('texra-workspace-storage-', tempDirs);
    const workspacePath = '/workspace/a';
    const existingCurrent = await resolveExistingRunStoragePath(
      ['run-1', 'result.json'],
      async (storagePath) => storagePath === 'executions/run-1/result.json',
    );
    const existingLegacy = await resolveExistingRunStoragePath(
      ['legacy-run'],
      async (storagePath) => storagePath === 'taskRuns/legacy-run',
    );

    expect([
      resolveGlobalStoragePath(root),
      resolveWorkspaceStoragePath(root, workspacePath),
      MEMORY_STORAGE_DIR,
      resolveMemoryStoragePath('memories/project.md'),
      RUNS_STORAGE_DIR,
      resolveRunStoragePath('run-1', 'result.json'),
      resolveRunOriginalSnapshotPath('run-1', 'Draft/Draft.tex'),
      LEGACY_RUNS_STORAGE_DIR,
      resolveLegacyRunStoragePath('legacy-run'),
      existingCurrent,
      existingLegacy,
    ]).toEqual([
      join(root, 'global-storage'),
      join(root, 'workspace-storage', workspaceStorageId(workspacePath)),
      'memories',
      'memories/project.md',
      'executions',
      'executions/run-1/result.json',
      'executions/run-1/original/Draft/Draft.tex',
      'taskRuns',
      'taskRuns/legacy-run',
      'executions/run-1/result.json',
      'taskRuns/legacy-run',
    ]);
    expect(() => resolveMemoryStoragePath('not-memories/project.md')).toThrow(
      'Invalid memory path',
    );
  });

  it('creates workspace-scoped storage roots on demand', async () => {
    const root = await makeTempDir('texra-workspace-storage-', tempDirs);
    let workspacePath: string | undefined = '/workspace/a';
    const provider = new WorkspaceStorageProvider(root, () => workspacePath);
    const firstStoragePath = provider.getStoragePath();

    workspacePath = '/workspace/b';
    expect(provider.getStoragePath()).toBe(firstStoragePath);
    expect(provider.hasPendingWorkspaceStorageChange()).toBe(true);
    expect(provider.commitWorkspaceStorageChange()).toBe(true);
    const secondStoragePath = provider.getStoragePath();

    expect(provider.hasPendingWorkspaceStorageChange()).toBe(false);
    provider.finalizeWorkspaceStorageChange();
    expect(provider.commitWorkspaceStorageChange()).toBe(false);
    expect(provider.getGlobalStoragePath()).toBe(join(root, 'global-storage'));
    expect(firstStoragePath).not.toBe(secondStoragePath);
    await expect(pathExists(firstStoragePath)).resolves.toBe(true);
    await expect(pathExists(secondStoragePath)).resolves.toBe(true);
    await expect(readWorkspaceMarker(firstStoragePath)).resolves.toMatchObject({
      path: '/workspace/a',
    });
    await expect(readWorkspaceMarker(secondStoragePath)).resolves.toMatchObject(
      { path: '/workspace/b' },
    );
  });

  it('restores the previous root after a failed workspace replacement', async () => {
    const root = await makeTempDir('texra-workspace-storage-', tempDirs);
    let workspacePath: string | undefined = '/workspace/a';
    const provider = new WorkspaceStorageProvider(root, () => workspacePath);
    const firstStoragePath = provider.getStoragePath();

    workspacePath = '/workspace/b';
    expect(provider.commitWorkspaceStorageChange()).toBe(true);
    expect(provider.getStoragePath()).not.toBe(firstStoragePath);
    expect(provider.rollbackWorkspaceStorageChange()).toBe(true);

    expect(provider.getStoragePath()).toBe(firstStoragePath);
    expect(provider.hasPendingWorkspaceStorageChange()).toBe(true);
    expect(provider.rollbackWorkspaceStorageChange()).toBe(false);
  });

  it('migrates legacy hash-only workspace storage when possible', async () => {
    const root = await makeTempDir('texra-workspace-storage-', tempDirs);
    const workspacePath = '/workspace/Legacy Project';
    const legacyStoragePath = join(
      root,
      'workspace-storage',
      'dda160810e1d2a9f',
    );
    const legacyMarkerPath = join(legacyStoragePath, 'marker.txt');

    await mkdir(legacyStoragePath, { recursive: true });
    await writeFile(legacyMarkerPath, 'legacy', 'utf8');

    const provider = new WorkspaceStorageProvider(root, workspacePath);
    const storagePath = provider.getStoragePath();

    expect(storagePath).toBe(
      join(root, 'workspace-storage', workspaceStorageId(workspacePath)),
    );
    await expect(pathExists(legacyStoragePath)).resolves.toBe(false);
    await expect(pathExists(join(storagePath, 'marker.txt'))).resolves.toBe(
      true,
    );
    await expect(readWorkspaceMarker(storagePath)).resolves.toMatchObject({
      path: workspacePath,
    });
  });

  it('initializes each workspace storage root only once', async () => {
    const root = await makeTempDir('texra-workspace-storage-', tempDirs);
    const workspacePath = '/workspace/a';
    const provider = new WorkspaceStorageProvider(root, workspacePath);
    const storagePath = provider.getStoragePath();

    await rm(storagePath, { recursive: true, force: true });

    expect(provider.getStoragePath()).toBe(storagePath);
    await expect(pathExists(storagePath)).resolves.toBe(false);
  });

  it('uses the same workspace storage rule for node hosts', async () => {
    const root = await makeTempDir('texra-workspace-storage-', tempDirs);
    const workspacePath = '/workspace/a';
    const provider = createNodeStorageProvider({
      storageRoot: root,
      workspacePath,
    });

    expect(provider.getGlobalStoragePath()).toBe(join(root, 'global-storage'));
    expect(provider.getStoragePath()).toBe(
      join(root, 'workspace-storage', workspaceStorageId(workspacePath)),
    );
  });
});
