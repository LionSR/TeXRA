// Node imports
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports - platform
import { createNodeStorageProvider } from '@platform/defaults/nodeStorage';
import {
  createWorkspaceStorageProvider,
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
  workspaceStorageId,
} from '@platform/defaults/workspaceStorage';

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

describe('workspace storage defaults', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    const paths = tempDirs.splice(0);
    await Promise.all(
      paths.map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function makeTempDir(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'texra-workspace-storage-'));
    tempDirs.push(path);
    return path;
  }

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

  it('resolves global and workspace storage paths from one root', async () => {
    const root = await makeTempDir();
    const workspacePath = '/workspace/a';

    expect(resolveGlobalStoragePath(root)).toBe(join(root, 'global-storage'));
    expect(resolveWorkspaceStoragePath(root, workspacePath)).toBe(
      join(root, 'workspace-storage', workspaceStorageId(workspacePath)),
    );
  });

  it('creates workspace-scoped storage roots on demand', async () => {
    const root = await makeTempDir();
    let workspacePath: string | undefined = '/workspace/a';
    const provider = createWorkspaceStorageProvider(root, () => workspacePath);
    const firstStoragePath = provider.getStoragePath();

    workspacePath = '/workspace/b';
    const secondStoragePath = provider.getStoragePath();

    expect(provider.getGlobalStoragePath()).toBe(join(root, 'global-storage'));
    expect(firstStoragePath).not.toBe(secondStoragePath);
    await expect(pathExists(firstStoragePath)).resolves.toBe(true);
    await expect(pathExists(secondStoragePath)).resolves.toBe(true);
    await expect(
      readJsonFile<{ path: string }>(join(firstStoragePath, '_workspace.json')),
    ).resolves.toMatchObject({ path: '/workspace/a' });
    await expect(
      readJsonFile<{ path: string }>(
        join(secondStoragePath, '_workspace.json'),
      ),
    ).resolves.toMatchObject({ path: '/workspace/b' });
  });

  it('migrates legacy hash-only workspace storage when possible', async () => {
    const root = await makeTempDir();
    const workspacePath = '/workspace/Legacy Project';
    const legacyStoragePath = join(
      root,
      'workspace-storage',
      'dda160810e1d2a9f',
    );
    const legacyMarkerPath = join(legacyStoragePath, 'marker.txt');

    await mkdir(legacyStoragePath, { recursive: true });
    await writeFile(legacyMarkerPath, 'legacy', 'utf8');

    const provider = createWorkspaceStorageProvider(root, workspacePath);
    const storagePath = provider.getStoragePath();

    expect(storagePath).toBe(
      join(root, 'workspace-storage', workspaceStorageId(workspacePath)),
    );
    await expect(pathExists(legacyStoragePath)).resolves.toBe(false);
    await expect(pathExists(join(storagePath, 'marker.txt'))).resolves.toBe(
      true,
    );
    await expect(
      readJsonFile<{ path: string }>(join(storagePath, '_workspace.json')),
    ).resolves.toMatchObject({ path: workspacePath });
  });

  it('uses the same workspace storage rule for node hosts', async () => {
    const root = await makeTempDir();
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
