// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports - platform
import type { ElectronSecrets as ElectronSecretsInstance } from '@desktop/main/platform/electronSecrets';
import type { JsonStore } from '@platform/defaults/jsonStore';

// Local imports - test support
import { withEnv } from '@test/support/testEnv';
import { loadSourceModule } from './loadSourceModule.ts';

interface SafeStorageMethods {
  decryptString: (value: Buffer) => string;
  encryptString: (value: string) => Buffer;
  isEncryptionAvailable: () => boolean;
}

function loadElectronSecrets(): Promise<
  typeof import('@desktop/main/platform/electronSecrets')
> {
  return loadSourceModule('@desktop/main/platform/electronSecrets');
}

async function safeStorageStub(): Promise<SafeStorageMethods> {
  const electron = (await import('electron')) as unknown as {
    safeStorage: SafeStorageMethods;
  };
  return electron.safeStorage;
}

async function resetKeychainState(): Promise<void> {
  const mod = await loadElectronSecrets();
  mod.__resetKeychainStateForTests();
  vi.restoreAllMocks();
}

/** A store whose reads are driven by the test, standing in for a JsonStore. */
function stubStore(store: {
  get<T>(key: string): T | undefined;
  set?(key: string, value: unknown): Effect.Effect<void>;
}): JsonStore {
  return store as unknown as JsonStore;
}

// A persisted store record for one encrypted secret, as ElectronSecrets.set() writes it.
function encryptedRecordStore(): JsonStore {
  return stubStore({
    get<T>(_key: string): T | undefined {
      return {
        encrypted: true,
        value: Buffer.from('encrypted:value').toString('base64'),
      } as unknown as T;
    },
  });
}

/** A store with no persisted records. */
function emptyRecordStore(): JsonStore {
  return stubStore({
    get<T>(_key: string): T | undefined {
      return undefined;
    },
  });
}

/** An ElectronSecrets over one encrypted record, with its warnings captured. */
async function secretsWithWarningLog(): Promise<{
  secrets: ElectronSecretsInstance;
  warnings: string[];
}> {
  const { ElectronSecrets } = await loadElectronSecrets();
  const warnings: string[] = [];
  const secrets = new ElectronSecrets(encryptedRecordStore(), {
    showWarningMessage: (message: string) =>
      Effect.sync(() => {
        warnings.push(message);
      }),
  });
  return { secrets, warnings };
}

describe('ElectronSecrets keychain-denial bootstrap recovery', () => {
  afterEach(resetKeychainState);

  it.effect(
    'answers "no saved secret" (instead of failing) when safeStorage.decryptString throws',
    () =>
      Effect.gen(function* () {
        // The keychain denial path: decryptString rejects after the user
        // clicks "Don't Allow" or the encryption key is otherwise
        // unavailable. The bug we are guarding against is this failure
        // reaching the renderer bootstrap and producing a blank window, so
        // `decrypt-failed` is recovered inside the store rather than raised
        // into the caller's channel.
        const decryptSpy = vi
          .spyOn(yield* Effect.promise(safeStorageStub), 'decryptString')
          .mockImplementation(() => {
            throw new Error('User denied keychain access');
          });

        const { secrets, warnings } = yield* Effect.promise(
          secretsWithWarningLog,
        );

        expect(yield* secrets.get('texra.api.openai')).toBeUndefined();
        expect(decryptSpy).toHaveBeenCalledOnce();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('keychain');
      }).pipe(withEnv({})),
  );

  it.effect(
    'only surfaces the keychain-denied warning once per ElectronSecrets instance',
    () =>
      Effect.gen(function* () {
        const decryptSpy = vi
          .spyOn(yield* Effect.promise(safeStorageStub), 'decryptString')
          .mockImplementation(() => {
            throw new Error('denied');
          });
        const { secrets, warnings } = yield* Effect.promise(
          secretsWithWarningLog,
        );

        yield* secrets.get('a');
        yield* secrets.get('b');
        yield* secrets.get('c');

        expect(warnings).toHaveLength(1);
        expect(decryptSpy).toHaveBeenCalledOnce();
      }).pipe(withEnv({})),
  );
});

describe('TEXRA_DISABLE_KEYCHAIN env var (Playwright e2e shim)', () => {
  afterEach(resetKeychainState);

  it.effect(
    'reports unavailable storage mode without touching safeStorage',
    () =>
      Effect.gen(function* () {
        const isAvailableSpy = vi.spyOn(
          yield* Effect.promise(safeStorageStub),
          'isEncryptionAvailable',
        );

        const mod = yield* Effect.promise(loadElectronSecrets);

        expect(yield* mod.getSecretStorageMode()).toBe('unavailable');
        expect(isAvailableSpy).not.toHaveBeenCalled();
      }).pipe(withEnv({ TEXRA_DISABLE_KEYCHAIN: '1' })),
  );

  it.effect(
    'ElectronSecrets.get() returns undefined without calling safeStorage',
    () =>
      Effect.gen(function* () {
        const decryptSpy = vi.spyOn(
          yield* Effect.promise(safeStorageStub),
          'decryptString',
        );

        const { ElectronSecrets } = yield* Effect.promise(loadElectronSecrets);
        const secrets = new ElectronSecrets(encryptedRecordStore());

        expect(yield* secrets.get('any.key')).toBeUndefined();
        expect(decryptSpy).not.toHaveBeenCalled();
      }).pipe(withEnv({ TEXRA_DISABLE_KEYCHAIN: '1' })),
  );

  it.effect(
    'ElectronSecrets.get() still honors process.env overrides above the env-disabled shim',
    () =>
      Effect.gen(function* () {
        const { ElectronSecrets } = yield* Effect.promise(loadElectronSecrets);
        const secrets = new ElectronSecrets(emptyRecordStore());

        expect(yield* secrets.get('SOME_TEST_KEY')).toBe('from-env');
      }).pipe(
        withEnv({ TEXRA_DISABLE_KEYCHAIN: '1', SOME_TEST_KEY: 'from-env' }),
      ),
  );

  it.effect('ElectronSecrets.set() silently no-ops instead of throwing', () =>
    Effect.gen(function* () {
      const encryptSpy = vi.spyOn(
        yield* Effect.promise(safeStorageStub),
        'encryptString',
      );

      const { ElectronSecrets } = yield* Effect.promise(loadElectronSecrets);
      const writes: Array<[string, unknown]> = [];
      const secrets = new ElectronSecrets(
        stubStore({
          get<T>(_key: string): T | undefined {
            return undefined;
          },
          set(key: string, value: unknown): Effect.Effect<void> {
            return Effect.sync(() => {
              writes.push([key, value]);
            });
          },
        }),
      );

      expect(yield* secrets.set('a', 'b')).toBeUndefined();
      expect(writes).toEqual([]);
      expect(encryptSpy).not.toHaveBeenCalled();
    }).pipe(withEnv({ TEXRA_DISABLE_KEYCHAIN: '1' })),
  );

  it.effect('accepts the literal string "true" in addition to "1"', () =>
    Effect.gen(function* () {
      const mod = yield* Effect.promise(loadElectronSecrets);
      expect(yield* mod.getSecretStorageMode()).toBe('unavailable');
    }).pipe(withEnv({ TEXRA_DISABLE_KEYCHAIN: 'true' })),
  );
});
