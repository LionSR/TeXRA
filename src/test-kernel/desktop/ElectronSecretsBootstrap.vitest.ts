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
