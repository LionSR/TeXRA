// Node imports
import { join } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports - platform
import type { ElectronSecrets } from '@desktop/main/platform/electronSecrets';
import type { JsonStore } from '@platform/defaults/jsonStore';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';

// Local imports - test support
import { pathExists } from '@test/support/fsTestUtils';
import {
  makeTempDir as makeSharedTempDir,
  useTempDirs,
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

const loadJsonStore = Effect.promise(async () => {
  const { JsonStore } = await loadSourceModule('@platform/defaults/jsonStore');
  return JsonStore;
});

describe('desktop platform adapters', () => {
  const tempDirs = useTempDirs();
  const originalEnv = { ...process.env };
  const testSecretKey = 'TEXRA_TEST_TOKEN';

  afterEach(async () => {
    process.env = { ...originalEnv };
    const stubUserDataPath = getElectronTestStubUserDataPath();
    if (stubUserDataPath != null) tempDirs.push(stubUserDataPath);
    resetElectronTestStub();
    vi.restoreAllMocks();
  });

  const makeTempDir = (prefix: string) =>
    Effect.promise(() => makeSharedTempDir(prefix, tempDirs));

  const loadSecrets = (
    options?: ConstructorParameters<
      ElectronSecretsModule['ElectronSecrets']
    >[1],
  ) =>
    Effect.gen(function* () {
      const [secretsModule, JsonStore] = yield* Effect.all(
        [
          Effect.promise(() =>
            loadSourceModule('@desktop/main/platform/electronSecrets'),
          ),
          loadJsonStore,
        ],
        { concurrency: 2 },
      );
      const root = yield* makeTempDir('texra-electron-secrets-');
      const store = yield* JsonStore.open(join(root, 'secrets.json'));
      const secrets = new secretsModule.ElectronSecrets(store, options);
      return { module: secretsModule, store, secrets };
    });

  /** The rejection a `secrets.set` write surfaces, in the error channel. */
  const secretWriteError = (secrets: ElectronSecrets) =>
    Effect.flip(
      Effect.tryPromise({
        try: () => secrets.set(testSecretKey, 'persisted'),
        catch: (error) => error,
      }),
    );

  it.effect(
    'persists state values and deletes undefined updates through JsonStore',
    () =>
      Effect.gen(function* () {
        const JsonStore = yield* loadJsonStore;
        const root = yield* makeTempDir('texra-electron-state-');
        const store = yield* JsonStore.open(join(root, 'state.json'));

        yield* store.set('session', { active: true });
        yield* store.set('cleared', 'value');
        yield* store.set('cleared', undefined);

        expect(store.get('session')).toEqual({ active: true });
        expect(store.get('missing', 'fallback')).toBe('fallback');
        expect(store.snapshot()).toEqual({ session: { active: true } });
      }),
  );

  it.effect(
    'creates stable global and workspace storage roots under userData',
    () =>
      Effect.gen(function* () {
        const root = yield* makeTempDir('texra-electron-storage-');

        const first = new WorkspaceStorageProvider(root, '/workspace/a');
        const same = new WorkspaceStorageProvider(root, '/workspace/a');
        const other = new WorkspaceStorageProvider(root, '/workspace/b');
        const noWorkspace = new WorkspaceStorageProvider(root, undefined);

        expect(first.getGlobalStoragePath()).toBe(
          join(root, 'v1', 'global-storage'),
        );
        expect(first.getStoragePath()).toBe(same.getStoragePath());
        expect(first.getStoragePath()).not.toBe(other.getStoragePath());
        expect(noWorkspace.getStoragePath()).toMatch(/workspace-storage/);
        expect(
          yield* Effect.promise(() => pathExists(first.getGlobalStoragePath())),
        ).toBe(true);
        expect(
          yield* Effect.promise(() => pathExists(first.getStoragePath())),
        ).toBe(true);
        expect(
          yield* Effect.promise(() => pathExists(noWorkspace.getStoragePath())),
        ).toBe(true);
      }),
  );

  it.effect(
    'stores encrypted secrets, supports env overrides, and deletes persisted values',
    () =>
      Effect.gen(function* () {
        const {
          module: { getSecretStorageMode },
          store,
          secrets,
        } = yield* loadSecrets();

        expect(getSecretStorageMode()).toBe('encrypted');
        yield* Effect.promise(() => secrets.set(testSecretKey, 'persisted'));

        expect(yield* Effect.promise(() => secrets.get(testSecretKey))).toBe(
          'persisted',
        );
        expect(store.snapshot()[testSecretKey]).toMatchObject({
          encrypted: true,
          value: expect.any(String),
        });

        process.env[testSecretKey] = 'from-env';
        expect(yield* Effect.promise(() => secrets.get(testSecretKey))).toBe(
          'from-env',
        );

        delete process.env[testSecretKey];
        yield* Effect.promise(() => secrets.delete(testSecretKey));

        expect(
          yield* Effect.promise(() => secrets.get(testSecretKey)),
        ).toBeUndefined();
        expect(store.snapshot()).toEqual({});
      }),
  );

  it.effect(
    'rejects secret writes when Electron safe storage is unavailable',
    () =>
      Effect.gen(function* () {
        const {
          module: { getSecretStorageMode },
          store,
          secrets,
        } = yield* loadSecrets();

        configureElectronTestStub({ safeStorageEncryptionAvailable: false });

        expect(getSecretStorageMode()).toBe('unavailable');
        expect(yield* secretWriteError(secrets)).toEqual(
          new Error('Electron safeStorage is unavailable for secret writes.'),
        );
        expect(store.snapshot()).toEqual({});
      }),
  );

  it.effect(
    'warns once and rejects secret writes on the Linux basic_text safe storage backend',
    () =>
      Effect.gen(function* () {
        const showWarningMessage = vi.fn();
        const {
          module: {
            LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE,
            getSecretStorageMode,
          },
          store,
          secrets,
        } = yield* loadSecrets({ showWarningMessage });

        vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
        configureElectronTestStub({ safeStorageBackend: 'basic_text' });

        expect(getSecretStorageMode()).toBe('basic_text');
        expect(yield* secretWriteError(secrets)).toEqual(
          new Error(LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE),
        );
        expect(yield* secretWriteError(secrets)).toEqual(
          new Error(LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE),
        );
        expect(showWarningMessage).toHaveBeenCalledTimes(1);
        expect(showWarningMessage).toHaveBeenCalledWith(
          LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE,
        );
        expect(store.snapshot()).toEqual({});
      }),
  );

  it.effect(
    'preserves the storage-policy error when the basic_text warning fails',
    () =>
      Effect.gen(function* () {
        const {
          module: { LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE },
          store,
          secrets,
        } = yield* loadSecrets({
          showWarningMessage: vi.fn(async () => {
            throw new Error('dialog failed');
          }),
        });

        vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
        configureElectronTestStub({ safeStorageBackend: 'basic_text' });

        expect(yield* secretWriteError(secrets)).toEqual(
          new Error(LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE),
        );
        expect(store.snapshot()).toEqual({});
      }),
  );

  it.effect('ignores malformed persisted secret records', () =>
    Effect.gen(function* () {
      const { store, secrets } = yield* loadSecrets();

      yield* store.set(testSecretKey, { encrypted: false, value: 'plain' });

      expect(
        yield* Effect.promise(() => secrets.get(testSecretKey)),
      ).toBeUndefined();
    }),
  );
});
