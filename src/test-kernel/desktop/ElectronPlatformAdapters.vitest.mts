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
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - platform
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';

// Local imports - test support
import {
  app as electronApp,
  configureElectronTestStub,
  getElectronTestStubUserDataPath,
  resetElectronTestStub,
  safeStorage as electronSafeStorage,
} from './electronTestStub.mjs';
import { REPO_ROOT } from './desktopTestPaths.mjs';
import { loadDesktopPlatformModule } from './loadDesktopPlatformModule.mjs';
import { loadPlatformDefaultsModule } from './loadPlatformDefaultsModule.mjs';

interface JsonStore {
  get<T>(key: string, defaultValue?: T): T;
  set(key: string, value: unknown): Promise<void>;
  update(key: string, value: unknown): Promise<void>;
  snapshot(): Record<string, unknown>;
}

interface JsonStoreModule {
  JsonStore: {
    open(
      filePath: string,
      options: { corruptionPolicy: 'fail' },
    ): Promise<JsonStore>;
  };
}

interface ElectronSecrets {
  delete(key: string): Promise<void>;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

interface DataRootMigrationLogger {
  info(message: string): void;
  warn(message: string): void;
}

interface DataRootMigrationModule {
  migrateLegacyDesktopDataRoot(
    legacyRoot: string,
    targetRoot: string,
    logger?: DataRootMigrationLogger,
  ): Promise<void>;
}

interface ElectronSecretsModule {
  getSecretStorageMode: () => 'encrypted' | 'basic_text' | 'unavailable';
  LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE: string;
  ElectronSecrets: new (
    store: JsonStore,
    options?: {
      showWarningMessage?: (message: string) => Promise<void> | void;
    },
  ) => ElectronSecrets;
}

async function loadJsonStore(): Promise<JsonStoreModule['JsonStore']> {
  const { JsonStore } =
    await loadPlatformDefaultsModule<JsonStoreModule>('jsonStore.ts');
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
    const pathsToRemove = [...new Set(tempDirs.splice(0))];
    await Promise.all(
      pathsToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function makeTempDir(prefix: string): Promise<string> {
    const tempDir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(tempDir);
    return tempDir;
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
      loadDesktopPlatformModule<ElectronSecretsModule>('electronSecrets.ts'),
      loadJsonStore(),
    ]);
    const root = await makeTempDir('texra-electron-secrets-');
    const store = await JsonStore.open(join(root, 'secrets.json'), {
      corruptionPolicy: 'fail',
    });
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
    const store = await JsonStore.open(join(root, 'state.json'), {
      corruptionPolicy: 'fail',
    });

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

  function fakeMigrationLogger(): DataRootMigrationLogger & {
    infoMessages: string[];
    warnMessages: string[];
  } {
    const infoMessages: string[] = [];
    const warnMessages: string[] = [];
    return {
      infoMessages,
      warnMessages,
      info: (message) => infoMessages.push(message),
      warn: (message) => warnMessages.push(message),
    };
  }

  describe('legacy userData data-root migration (#7987)', () => {
    async function loadMigration(): Promise<
      DataRootMigrationModule['migrateLegacyDesktopDataRoot']
    > {
      const { migrateLegacyDesktopDataRoot } =
        await loadDesktopPlatformModule<DataRootMigrationModule>(
          'dataRootMigration.ts',
        );
      return migrateLegacyDesktopDataRoot;
    }

    it('is a no-op on a fresh install with no legacy userData store', async () => {
      const migrateLegacyDesktopDataRoot = await loadMigration();
      const legacyRoot = await makeTempDir('texra-migration-legacy-fresh-');
      const targetRoot = await makeTempDir('texra-migration-target-fresh-');
      const logger = fakeMigrationLogger();

      await migrateLegacyDesktopDataRoot(legacyRoot, targetRoot, logger);

      await expect(
        pathExists(join(targetRoot, 'global-storage')),
      ).resolves.toBe(false);
      await expect(
        pathExists(join(targetRoot, 'workspace-storage')),
      ).resolves.toBe(false);
      expect(logger.infoMessages).toEqual([]);
      expect(logger.warnMessages).toEqual([]);
    });

    it('moves every legacy directory when the target root is empty', async () => {
      const migrateLegacyDesktopDataRoot = await loadMigration();
      const legacyRoot = await makeTempDir('texra-migration-legacy-present-');
      const targetRoot = await makeTempDir('texra-migration-target-present-');
      const logger = fakeMigrationLogger();

      await mkdir(join(legacyRoot, 'global-storage'), { recursive: true });
      await writeFile(
        join(legacyRoot, 'global-storage', 'state.json'),
        '{"legacy":true}',
      );
      await mkdir(join(legacyRoot, 'workspace-storage', 'proj-aaaa'), {
        recursive: true,
      });
      await writeFile(
        join(legacyRoot, 'workspace-storage', 'proj-aaaa', 'state.json'),
        '{"workspace":"proj-aaaa"}',
      );

      await migrateLegacyDesktopDataRoot(legacyRoot, targetRoot, logger);

      await expect(
        pathExists(join(legacyRoot, 'global-storage')),
      ).resolves.toBe(false);
      await expect(
        pathExists(join(legacyRoot, 'workspace-storage', 'proj-aaaa')),
      ).resolves.toBe(false);
      await expect(
        pathExists(join(targetRoot, 'global-storage', 'state.json')),
      ).resolves.toBe(true);
      await expect(
        pathExists(
          join(targetRoot, 'workspace-storage', 'proj-aaaa', 'state.json'),
        ),
      ).resolves.toBe(true);
      expect(logger.warnMessages).toEqual([]);
      expect(logger.infoMessages).toHaveLength(2);
    });

    it('skips-and-warns per directory instead of overwriting an existing target', async () => {
      const migrateLegacyDesktopDataRoot = await loadMigration();
      const legacyRoot = await makeTempDir('texra-migration-legacy-both-');
      const targetRoot = await makeTempDir('texra-migration-target-both-');
      const logger = fakeMigrationLogger();

      // global-storage collides at the target: must be skipped, never
      // overwritten.
      await mkdir(join(legacyRoot, 'global-storage'), { recursive: true });
      await writeFile(
        join(legacyRoot, 'global-storage', 'state.json'),
        '{"legacy":true}',
      );
      await mkdir(join(targetRoot, 'global-storage'), { recursive: true });
      await writeFile(
        join(targetRoot, 'global-storage', 'state.json'),
        '{"target":true}',
      );

      // Two workspace keys: one collides (must be skipped independently),
      // the other is only in the legacy tree (must still migrate).
      await mkdir(join(legacyRoot, 'workspace-storage', 'proj-collide'), {
        recursive: true,
      });
      await mkdir(join(targetRoot, 'workspace-storage', 'proj-collide'), {
        recursive: true,
      });
      await mkdir(join(legacyRoot, 'workspace-storage', 'proj-only-legacy'), {
        recursive: true,
      });

      await migrateLegacyDesktopDataRoot(legacyRoot, targetRoot, logger);

      // Collisions are left untouched on both sides, never clobbered.
      await expect(
        pathExists(join(legacyRoot, 'global-storage', 'state.json')),
      ).resolves.toBe(true);
      const targetGlobalState = await readFile(
        join(targetRoot, 'global-storage', 'state.json'),
        'utf8',
      );
      expect(JSON.parse(targetGlobalState)).toEqual({ target: true });
      await expect(
        pathExists(join(legacyRoot, 'workspace-storage', 'proj-collide')),
      ).resolves.toBe(true);

      // The non-colliding workspace key still migrates.
      await expect(
        pathExists(join(legacyRoot, 'workspace-storage', 'proj-only-legacy')),
      ).resolves.toBe(false);
      await expect(
        pathExists(join(targetRoot, 'workspace-storage', 'proj-only-legacy')),
      ).resolves.toBe(true);

      expect(logger.warnMessages).toHaveLength(2);
      expect(logger.warnMessages[0]).toContain('global-storage');
      expect(logger.warnMessages[0]).toContain(
        join(legacyRoot, 'global-storage'),
      );
      expect(logger.warnMessages[1]).toContain('proj-collide');
      expect(logger.warnMessages[1]).toContain(
        join(legacyRoot, 'workspace-storage', 'proj-collide'),
      );
      expect(logger.infoMessages).toEqual([
        expect.stringContaining('proj-only-legacy'),
      ]);
    });

    it('does not abort startup when the legacy workspace-storage directory cannot be read', async () => {
      const migrateLegacyDesktopDataRoot = await loadMigration();
      const legacyRoot = await makeTempDir(
        'texra-migration-legacy-unreadable-',
      );
      const targetRoot = await makeTempDir(
        'texra-migration-target-unreadable-',
      );
      const logger = fakeMigrationLogger();

      const legacyWorkspaceRoot = join(legacyRoot, 'workspace-storage');
      // A file (not a directory) at the expected workspace-storage path
      // makes readdir() reject with ENOTDIR, exercising the same
      // best-effort catch path as a permission-denied (EACCES) directory
      // without requiring platform-specific chmod tricks.
      await writeFile(legacyWorkspaceRoot, 'not a directory');

      await expect(
        migrateLegacyDesktopDataRoot(legacyRoot, targetRoot, logger),
      ).resolves.toBeUndefined();

      expect(logger.warnMessages).toHaveLength(1);
      expect(logger.warnMessages[0]).toContain(legacyWorkspaceRoot);
      await expect(
        pathExists(join(targetRoot, 'workspace-storage')),
      ).resolves.toBe(false);
    });

    it('is idempotent once a legacy directory has already been moved', async () => {
      const migrateLegacyDesktopDataRoot = await loadMigration();
      const legacyRoot = await makeTempDir('texra-migration-legacy-idem-');
      const targetRoot = await makeTempDir('texra-migration-target-idem-');
      const logger = fakeMigrationLogger();

      await mkdir(join(legacyRoot, 'global-storage'), { recursive: true });

      await migrateLegacyDesktopDataRoot(legacyRoot, targetRoot, logger);
      await migrateLegacyDesktopDataRoot(legacyRoot, targetRoot, logger);

      expect(logger.infoMessages).toHaveLength(1);
      expect(logger.warnMessages).toEqual([]);
    });

    it('is a no-op when the legacy root and target root are the same path', async () => {
      const migrateLegacyDesktopDataRoot = await loadMigration();
      const root = await makeTempDir('texra-migration-same-root-');
      const logger = fakeMigrationLogger();

      await mkdir(join(root, 'global-storage'), { recursive: true });

      await migrateLegacyDesktopDataRoot(root, root, logger);

      expect(logger.infoMessages).toEqual([]);
      expect(logger.warnMessages).toEqual([]);
      await expect(pathExists(join(root, 'global-storage'))).resolves.toBe(
        true,
      );
    });
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
