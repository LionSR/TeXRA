// Node imports
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - platform
import type { ElectronSecrets } from '@desktop/main/platform/electronSecrets';
import type { JsonStore } from '@platform/defaults/jsonStore';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';

// Local imports - test support
import {
  cleanupTempDirs,
  makeTempDir as makeSharedTempDir,
} from '@test/support/tempDirPlatform';
import {
  app as electronApp,
  configureElectronTestStub,
  getElectronTestStubUserDataPath,
  resetElectronTestStub,
  safeStorage as electronSafeStorage,
} from './electronTestStub.ts';
import { REPO_ROOT } from './desktopTestPaths.ts';
import { loadSourceModule } from './loadSourceModule.ts';

type ElectronSecretsModule =
  typeof import('@desktop/main/platform/electronSecrets');

async function loadJsonStore(): Promise<
  typeof import('@platform/defaults/jsonStore').JsonStore
> {
  const { JsonStore } = await loadSourceModule('@platform/defaults/jsonStore');
  return JsonStore;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

describe('desktop platform adapters', () => {
  const tempDirs: string[] = [];
  const originalEnv = { ...process.env };
  const testSecretKey = 'TEXRA_TEST_TOKEN';

  afterEach(async () => {
    process.env = { ...originalEnv };
    const stubUserDataPath = getElectronTestStubUserDataPath();
    if (stubUserDataPath != null) tempDirs.push(stubUserDataPath);
    resetElectronTestStub();
    vi.restoreAllMocks();
    await cleanupTempDirs(tempDirs);
  });

  async function makeTempDir(prefix: string): Promise<string> {
    return makeSharedTempDir(prefix, tempDirs);
  }

  async function loadSecrets(
    options?: ConstructorParameters<
      ElectronSecretsModule['ElectronSecrets']
    >[1],
  ): Promise<{
    module: ElectronSecretsModule;
    store: JsonStore;
    secrets: ElectronSecrets;
  }> {
    const [secretsModule, JsonStore] = await Promise.all([
      loadSourceModule('@desktop/main/platform/electronSecrets'),
      loadJsonStore(),
    ]);
    const root = await makeTempDir('texra-electron-secrets-');
    const store = await JsonStore.open(join(root, 'secrets.json'));
    const secrets = new secretsModule.ElectronSecrets(store, options);
    return { module: secretsModule, store, secrets };
  }

  it('keeps default Electron app paths isolated from the checkout', () => {
    const userDataPath = electronApp.getPath('userData');

    expect(userDataPath).not.toContain(REPO_ROOT);
    expect(userDataPath).toContain('texra-electron-test-');
    expect(electronApp.getPath('logs')).toBe(join(userDataPath, 'logs'));
  });

  it('allows tests to override Electron app paths', async () => {
    const root = await makeTempDir('texra-electron-user-data-');

    configureElectronTestStub({ userDataPath: root });

    expect(electronApp.getPath('userData')).toBe(root);
    expect(electronApp.getPath('logs')).toBe(join(root, 'logs'));
  });

  it('merges partial Electron stub safe storage configuration', () => {
    configureElectronTestStub({ safeStorageEncryptionAvailable: false });
    configureElectronTestStub({ safeStorageBackend: 'basic_text' });

    expect(electronSafeStorage.isEncryptionAvailable()).toBe(false);
    expect(electronSafeStorage.getSelectedStorageBackend()).toBe('basic_text');
  });

  it('persists state values and deletes undefined updates through JsonStore', async () => {
    const JsonStore = await loadJsonStore();
    const root = await makeTempDir('texra-electron-state-');
    const store = await JsonStore.open(join(root, 'state.json'));

    await store.update('session', { active: true });
    await store.update('cleared', 'value');
    await store.update('cleared', undefined);

    expect(store.get('session')).toEqual({ active: true });
    expect(store.get('missing', 'fallback')).toBe('fallback');
    expect(store.snapshot()).toEqual({ session: { active: true } });
  });

  it('creates stable global and workspace storage roots under userData', async () => {
    const root = await makeTempDir('texra-electron-storage-');

    const first = new WorkspaceStorageProvider(root, '/workspace/a');
    const same = new WorkspaceStorageProvider(root, '/workspace/a');
    const other = new WorkspaceStorageProvider(root, '/workspace/b');
    const noWorkspace = new WorkspaceStorageProvider(root, undefined);

    expect(first.getGlobalStoragePath()).toBe(join(root, 'global-storage'));
    expect(first.getStoragePath()).toBe(same.getStoragePath());
    expect(first.getStoragePath()).not.toBe(other.getStoragePath());
    expect(noWorkspace.getStoragePath()).toMatch(/workspace-storage/);
    await expect(pathExists(first.getGlobalStoragePath())).resolves.toBe(true);
    await expect(pathExists(first.getStoragePath())).resolves.toBe(true);
    await expect(pathExists(noWorkspace.getStoragePath())).resolves.toBe(true);
  });

  it('stores encrypted secrets, supports env overrides, and deletes persisted values', async () => {
    const {
      module: { getSecretStorageMode },
      store,
      secrets,
    } = await loadSecrets();

    expect(getSecretStorageMode()).toBe('encrypted');
    await secrets.set(testSecretKey, 'persisted');

    expect(await secrets.get(testSecretKey)).toBe('persisted');
    expect(store.snapshot()[testSecretKey]).toMatchObject({
      encrypted: true,
      value: expect.any(String),
    });

    process.env[testSecretKey] = 'from-env';
    expect(await secrets.get(testSecretKey)).toBe('from-env');

    delete process.env[testSecretKey];
    await secrets.delete(testSecretKey);

    expect(await secrets.get(testSecretKey)).toBeUndefined();
    expect(store.snapshot()).toEqual({});
  });

  it('rejects secret writes when Electron safe storage is unavailable', async () => {
    const {
      module: { getSecretStorageMode },
      store,
      secrets,
    } = await loadSecrets();

    configureElectronTestStub({ safeStorageEncryptionAvailable: false });

    expect(getSecretStorageMode()).toBe('unavailable');
    await expect(secrets.set(testSecretKey, 'persisted')).rejects.toThrow(
      'Electron safeStorage is unavailable for secret writes.',
    );
    expect(store.snapshot()).toEqual({});
  });

  it('warns once and rejects secret writes on the Linux basic_text safe storage backend', async () => {
    const showWarningMessage = vi.fn();
    const {
      module: { LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE, getSecretStorageMode },
      store,
      secrets,
    } = await loadSecrets({ showWarningMessage });

    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    configureElectronTestStub({ safeStorageBackend: 'basic_text' });

    expect(getSecretStorageMode()).toBe('basic_text');
    await expect(secrets.set(testSecretKey, 'persisted')).rejects.toThrow(
      LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE,
    );
    await expect(secrets.set(testSecretKey, 'persisted')).rejects.toThrow(
      LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE,
    );
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    expect(showWarningMessage).toHaveBeenCalledWith(
      LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE,
    );
    expect(store.snapshot()).toEqual({});
  });

  it('preserves the storage-policy error when the basic_text warning fails', async () => {
    const {
      module: { LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE },
      store,
      secrets,
    } = await loadSecrets({
      showWarningMessage: vi.fn(async () => {
        throw new Error('dialog failed');
      }),
    });

    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    configureElectronTestStub({ safeStorageBackend: 'basic_text' });

    await expect(secrets.set(testSecretKey, 'persisted')).rejects.toThrow(
      LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE,
    );
    expect(store.snapshot()).toEqual({});
  });

  it('ignores malformed persisted secret records', async () => {
    const { store, secrets } = await loadSecrets();

    await store.set(testSecretKey, { encrypted: false, value: 'plain' });

    expect(await secrets.get(testSecretKey)).toBeUndefined();
  });
});
