// Node imports
import { join } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports - platform
import type { ElectronSecrets } from '@desktop/main/platform/electronSecrets';
import { NotificationFailed } from '@hosts/uiHosts';

// Local imports - test support
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import {
  makeTempDir as makeSharedTempDir,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { withEnv } from '@test/support/testEnv';
import {
  configureElectronTestStub,
  getElectronTestStubUserDataPath,
  resetElectronTestStub,
  safeStorage as electronSafeStorage,
} from './electronTestStub.ts';
import { loadSourceModule } from './loadSourceModule.ts';

type ElectronSecretsModule =
  typeof import('@desktop/main/platform/electronSecrets');

const loadJsonStore = Effect.promise(async () => {
  const { JsonStore } = await loadSourceModule('@platform/defaults/jsonStore');
  return JsonStore;
});

describe('desktop platform adapters', () => {
  const tempDirs = useTempDirs();
  const testSecretKey = 'TEXRA_TEST_TOKEN';

  afterEach(async () => {
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

  /** The failure a `secrets.set` write surfaces, in the error channel. */
  const secretWriteError = (secrets: ElectronSecrets) =>
    Effect.flip(secrets.set(testSecretKey, 'persisted'));

  /** The store-unavailable failure a write reports, as a plain shape. */
  const unavailableWrite = (message: string) => ({
    _tag: 'SecretsFailed',
    reason: 'store-unavailable',
    operation: 'set',
    key: testSecretKey,
    message,
  });

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
      }).pipe(Effect.provide(nodePlatformLayer)),
  );

  it.effect('stores encrypted secrets and deletes persisted values', () =>
    Effect.gen(function* () {
      const {
        module: { getSecretStorageMode },
        store,
        secrets,
      } = yield* loadSecrets();

      expect(yield* getSecretStorageMode()).toBe('encrypted');
      yield* secrets.set(testSecretKey, 'persisted');

      expect(yield* secrets.get(testSecretKey)).toBe('persisted');
      expect(store.snapshot()[testSecretKey]).toMatchObject({
        encrypted: true,
        value: expect.any(String),
      });

      yield* secrets.delete(testSecretKey);

      expect(yield* secrets.get(testSecretKey)).toBeUndefined();
      expect(store.snapshot()).toEqual({});
    }).pipe(withEnv({}), Effect.provide(nodePlatformLayer)),
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

        expect(yield* getSecretStorageMode()).toBe('unavailable');
        expect(yield* secretWriteError(secrets)).toMatchObject(
          unavailableWrite(
            'Electron safeStorage is unavailable for secret writes.',
          ),
        );
        expect(store.snapshot()).toEqual({});
      }).pipe(withEnv({}), Effect.provide(nodePlatformLayer)),
  );

  it.effect(
    'reports a keychain that refuses encryption as a failed write, not a defect',
    () =>
      Effect.gen(function* () {
        const { store, secrets } = yield* loadSecrets();

        vi.spyOn(electronSafeStorage, 'encryptString').mockImplementation(
          () => {
            throw new Error('keychain refused the encryption');
          },
        );

        expect(yield* secretWriteError(secrets)).toMatchObject({
          _tag: 'SecretsFailed',
          reason: 'io',
          operation: 'set',
          key: testSecretKey,
        });
        expect(store.snapshot()).toEqual({});
      }).pipe(withEnv({}), Effect.provide(nodePlatformLayer)),
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

        expect(yield* getSecretStorageMode()).toBe('basic_text');
        expect(yield* secretWriteError(secrets)).toMatchObject(
          unavailableWrite(LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE),
        );
        expect(yield* secretWriteError(secrets)).toMatchObject(
          unavailableWrite(LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE),
        );
        expect(showWarningMessage).toHaveBeenCalledTimes(1);
        expect(showWarningMessage).toHaveBeenCalledWith(
          LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE,
        );
        expect(store.snapshot()).toEqual({});
      }).pipe(withEnv({}), Effect.provide(nodePlatformLayer)),
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
          showWarningMessage: vi.fn(() =>
            Effect.fail(
              new NotificationFailed({
                member: 'showWarningMessage',
                message: 'dialog failed',
                cause: new Error('dialog failed'),
              }),
            ),
          ),
        });

        vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
        configureElectronTestStub({ safeStorageBackend: 'basic_text' });

        expect(yield* secretWriteError(secrets)).toMatchObject(
          unavailableWrite(LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE),
        );
        expect(store.snapshot()).toEqual({});
      }).pipe(withEnv({}), Effect.provide(nodePlatformLayer)),
  );

  it.effect('ignores malformed persisted secret records', () =>
    Effect.gen(function* () {
      const { store, secrets } = yield* loadSecrets();

      yield* store.set(testSecretKey, { encrypted: false, value: 'plain' });

      expect(yield* secrets.get(testSecretKey)).toBeUndefined();
    }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
