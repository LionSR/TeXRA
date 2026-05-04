// Node imports
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports - test support
import { loadDesktopPlatformModule } from './loadDesktopPlatformModule.mjs';

interface JsonStore {
  get<T>(key: string, defaultValue?: T): T;
  set(key: string, value: unknown): Promise<void>;
  snapshot(): Record<string, unknown>;
}

interface JsonStoreModule {
  JsonStore: {
    open(filePath: string): Promise<JsonStore>;
  };
}

interface ElectronStateStore {
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

interface ElectronStateModule {
  ElectronStateStore: new (store: JsonStore) => ElectronStateStore;
}

interface ElectronStorageProvider {
  getGlobalStoragePath(): string;
  getStoragePath(): string;
}

interface ElectronStorageModule {
  ElectronStorageProvider: new (
    userDataPath: string,
    workspacePath: string | undefined,
  ) => ElectronStorageProvider;
}

interface ElectronSecrets {
  delete(key: string): Promise<void>;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

interface ElectronSecretsModule {
  ElectronSecrets: new (store: JsonStore) => ElectronSecrets;
}

async function loadJsonStore(): Promise<JsonStoreModule['JsonStore']> {
  const { JsonStore } =
    await loadDesktopPlatformModule<JsonStoreModule>('jsonStore.ts');
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
  let tempDir: string | undefined;
  const originalEnv = { ...process.env };

  afterEach(async () => {
    process.env = { ...originalEnv };
    if (tempDir == null) return;
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  async function makeTempDir(prefix: string): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), prefix));
    return tempDir;
  }

  it('persists state values and deletes undefined updates through JsonStore', async () => {
    const [{ JsonStore }, { ElectronStateStore }] = await Promise.all([
      loadDesktopPlatformModule<JsonStoreModule>('jsonStore.ts'),
      loadDesktopPlatformModule<ElectronStateModule>('electronState.ts'),
    ]);
    const root = await makeTempDir('texra-electron-state-');
    const store = await JsonStore.open(join(root, 'state.json'));
    const state = new ElectronStateStore(store);

    await state.update('session', { active: true });
    await state.update('cleared', 'value');
    await state.update('cleared', undefined);

    expect(state.get('session')).toEqual({ active: true });
    expect(state.get('missing', 'fallback')).toBe('fallback');
    expect(store.snapshot()).toEqual({ session: { active: true } });
  });

  it('creates stable global and workspace storage roots under userData', async () => {
    const { ElectronStorageProvider } =
      await loadDesktopPlatformModule<ElectronStorageModule>(
        'electronStorage.ts',
      );
    const root = await makeTempDir('texra-electron-storage-');

    const first = new ElectronStorageProvider(root, '/workspace/a');
    const same = new ElectronStorageProvider(root, '/workspace/a');
    const other = new ElectronStorageProvider(root, '/workspace/b');
    const noWorkspace = new ElectronStorageProvider(root, undefined);

    expect(first.getGlobalStoragePath()).toBe(join(root, 'global-storage'));
    expect(first.getStoragePath()).toBe(same.getStoragePath());
    expect(first.getStoragePath()).not.toBe(other.getStoragePath());
    expect(noWorkspace.getStoragePath()).toMatch(/workspace-storage/);
    await expect(pathExists(first.getGlobalStoragePath())).resolves.toBe(true);
    await expect(pathExists(first.getStoragePath())).resolves.toBe(true);
    await expect(pathExists(noWorkspace.getStoragePath())).resolves.toBe(true);
  });

  it('stores encrypted secrets, supports env overrides, and deletes persisted values', async () => {
    const [{ ElectronSecrets }, JsonStore] = await Promise.all([
      loadDesktopPlatformModule<ElectronSecretsModule>('electronSecrets.ts'),
      loadJsonStore(),
    ]);
    const root = await makeTempDir('texra-electron-secrets-');
    const store = await JsonStore.open(join(root, 'secrets.json'));
    const secrets = new ElectronSecrets(store);

    await secrets.set('TEXRA_TOKEN', 'persisted');

    expect(await secrets.get('TEXRA_TOKEN')).toBe('persisted');
    expect(store.snapshot().TEXRA_TOKEN).toEqual({
      encrypted: true,
      value: Buffer.from('encrypted:persisted').toString('base64'),
    });

    process.env.TEXRA_TOKEN = 'from-env';
    expect(await secrets.get('TEXRA_TOKEN')).toBe('from-env');

    delete process.env.TEXRA_TOKEN;
    await secrets.delete('TEXRA_TOKEN');

    expect(await secrets.get('TEXRA_TOKEN')).toBeUndefined();
    expect(store.snapshot()).toEqual({});
  });

  it('ignores malformed persisted secret records', async () => {
    const [{ ElectronSecrets }, JsonStore] = await Promise.all([
      loadDesktopPlatformModule<ElectronSecretsModule>('electronSecrets.ts'),
      loadJsonStore(),
    ]);
    const root = await makeTempDir('texra-electron-secrets-');
    const store = await JsonStore.open(join(root, 'secrets.json'));
    const secrets = new ElectronSecrets(store);

    await store.set('TEXRA_TOKEN', { encrypted: false, value: 'plain' });

    expect(await secrets.get('TEXRA_TOKEN')).toBeUndefined();
  });
});
