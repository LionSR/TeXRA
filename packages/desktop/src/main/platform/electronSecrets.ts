import { Effect } from 'effect';
import { safeStorage } from 'electron';

import {
  SecretsFailed,
  secretsGet,
  type PlatformSecrets,
  type SecretsOperation,
} from '@platform/secrets';
import { JsonStore, nodeFileServices } from '@platform/defaults/jsonStore';
import { assertNever } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { isEnvFlagEnabled } from '@utils/system/envFlags';

type StoredSecret = { encrypted: true; value: string };
type SecretStorageMode = 'encrypted' | 'basic_text' | 'unavailable';

interface ElectronSecretsOptions {
  showWarningMessage?: (message: string) => Promise<void> | void;
}

export const LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE =
  'TeXRA cannot store secrets securely because Electron is using Linux basic_text storage. Set up a system keyring such as GNOME Keyring/libsecret or KWallet, then restart TeXRA. Environment variables still work for API keys.';

const KEYCHAIN_DENIED_WARNING_MESSAGE =
  'TeXRA could not decrypt its saved secrets. This usually happens when the system keychain prompt was denied, but it can also occur with corrupted entries or rotated encryption keys. Saved API keys and sign-in sessions will not be available until decryption succeeds. Restart TeXRA after granting keychain access (or re-saving secrets) to retry.';

const SAFE_STORAGE_UNAVAILABLE_MESSAGE =
  'Electron safeStorage is unavailable for secret writes.';

/**
 * Test-harness shim: when `TEXRA_DISABLE_KEYCHAIN` is set the secrets layer
 * skips every `safeStorage` call so headless Playwright runs do not block on
 * the macOS keychain prompt. Not exposed as a user-facing toggle — env-var
 * API keys still work via the existing override in `ElectronSecrets.get()`.
 */
function isKeychainDisabled(): boolean {
  return isEnvFlagEnabled('TEXRA_DISABLE_KEYCHAIN');
}

let warnedAboutKeychainDisabled = false;
function warnKeychainDisabledOnce(): void {
  if (warnedAboutKeychainDisabled) return;
  warnedAboutKeychainDisabled = true;
  console.warn(
    'ElectronSecrets: TEXRA_DISABLE_KEYCHAIN is set; safeStorage is bypassed. ' +
      'Persisted secrets will not be readable or writable in this session. ' +
      'API keys can still be supplied through environment variables.',
  );
}

function isStoredSecret(value: unknown): value is StoredSecret {
  return (
    typeof value === 'object' &&
    value !== null &&
    'encrypted' in value &&
    value.encrypted === true &&
    'value' in value &&
    typeof value.value === 'string'
  );
}

type WarnOnceKind = 'basicText' | 'keychainDenied';

export class ElectronSecrets implements PlatformSecrets {
  private readonly warnedOnce = new Set<WarnOnceKind>();
  private keychainDecryptUnavailable = false;

  constructor(
    private readonly filePath: string,
    private readonly options: ElectronSecretsOptions = {},
  ) {}

  /** Environment variables override persisted Electron secrets. */
  get(key: string) {
    return secretsGet(this, key);
  }

  getStored(key: string) {
    return Effect.gen({ self: this }, function* () {
      // Test-harness shim: skip safeStorage entirely when the env var is set
      // so headless Playwright runs do not block on the macOS keychain
      // prompt. Env-var API key overrides already returned; here we just
      // report "no saved secret" rather than touching safeStorage.
      if (isKeychainDisabled()) {
        warnKeychainDisabledOnce();
        return undefined;
      }
      if (this.keychainDecryptUnavailable) return undefined;
      const store = yield* this.openStore('getStored', key);
      const stored = store.get<unknown>(key);
      if (!isStoredSecret(stored)) return undefined;
      const decrypted = yield* Effect.try({
        try: () =>
          safeStorage.decryptString(Buffer.from(stored.value, 'base64')),
        catch: (cause) =>
          new SecretsFailed({
            reason: 'decrypt-failed',
            operation: 'getStored',
            key,
            message: `safeStorage.decryptString failed for "${key}": ${toErrorMessage(cause)}`,
            cause,
          }),
      }).pipe(
        // The macOS keychain (and Linux libsecret/KWallet) can reject
        // decrypts when the user denies the OS prompt or the entry
        // encryption key has been rotated. Treat this as "no saved secret"
        // so the rest of the app — most importantly the renderer bootstrap —
        // keeps working. Without this recovery, a single decrypt rejection
        // during launch surfaces as a failed renderer bootstrap and leaves
        // the user staring at a blank white window. It is loud, not silent:
        // the cause is logged and the user is warned once.
        Effect.catchTag('SecretsFailed', (failure) =>
          Effect.as(this.reportDecryptFailure(failure), undefined),
        ),
      );
      return decrypted;
    });
  }

  /** Uninterruptible commit region: see `PlatformSecrets` (study Q2). */
  set(key: string, value: string) {
    return Effect.gen({ self: this }, function* () {
      // Test-harness shim: with the env var set, skip writes instead of
      // failing on the unavailable storage mode. The harness explicitly opts
      // out of persisted secrets, so a failure would break the same
      // bootstrap path we are trying to keep alive.
      if (isKeychainDisabled()) {
        warnKeychainDisabledOnce();
        return;
      }
      const storageMode = getSecretStorageMode();
      switch (storageMode) {
        case 'encrypted': {
          const stored: StoredSecret = {
            encrypted: true,
            value: safeStorage.encryptString(value).toString('base64'),
          };
          return yield* this.commit('set', key, stored);
        }
        case 'unavailable':
          return yield* Effect.fail(
            new SecretsFailed({
              reason: 'store-unavailable',
              operation: 'set',
              key,
              message: SAFE_STORAGE_UNAVAILABLE_MESSAGE,
            }),
          );
        case 'basic_text':
          yield* this.warnOnce(
            'basicText',
            LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE,
          );
          return yield* Effect.fail(
            new SecretsFailed({
              reason: 'store-unavailable',
              operation: 'set',
              key,
              message: LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE,
            }),
          );
        default:
          assertNever(storageMode, 'Unhandled Electron secret storage mode');
      }
    });
  }

  /** Uninterruptible commit region: see `PlatformSecrets` (study Q2). */
  delete(key: string) {
    return this.commit('delete', key, undefined);
  }

  listStoredKeys(): Effect.Effect<readonly string[], SecretsFailed> {
    return Effect.map(this.openStore('listStoredKeys'), (store) =>
      store.keys(),
    );
  }

  getEnv(name: string): string | undefined {
    return process.env[name];
  }

  /**
   * Open the store, apply the mutation, flush. Uninterruptible as a whole so
   * a cancelled caller either never wrote or wrote completely (study Q2).
   */
  private commit(
    operation: SecretsOperation,
    key: string,
    value: StoredSecret | undefined,
  ): Effect.Effect<void, SecretsFailed> {
    return Effect.uninterruptible(
      Effect.flatMap(this.openStore(operation, key), (store) =>
        store
          .update(key, value)
          .pipe(
            Effect.mapError((cause) => this.ioFailure(operation, cause, key)),
          ),
      ),
    );
  }

  private openStore(operation: SecretsOperation, key?: string) {
    return JsonStore.open(this.filePath).pipe(
      Effect.mapError((cause) => this.ioFailure(operation, cause, key)),
      Effect.provide(nodeFileServices),
    );
  }

  private ioFailure(
    operation: SecretsOperation,
    cause: unknown,
    key?: string,
  ): SecretsFailed {
    return new SecretsFailed({
      reason: 'io',
      operation,
      key,
      message: `The desktop secret store at ${this.filePath} failed to ${operation}${key ? ` "${key}"` : ''}: ${toErrorMessage(cause)}`,
      cause,
    });
  }

  /** Latch the store as unreadable, log the cause, warn the user once. */
  private reportDecryptFailure(failure: SecretsFailed) {
    return Effect.gen({ self: this }, function* () {
      this.keychainDecryptUnavailable = true;
      console.warn(`ElectronSecrets: ${failure.message}; treating as unset.`);
      yield* this.warnOnce('keychainDenied', KEYCHAIN_DENIED_WARNING_MESSAGE);
    });
  }

  /**
   * Shows a dialog once per kind per instance. Best-effort: a failed dialog
   * must not affect the outcome of the secret operation that triggered it
   * (the basic_text write still fails with the storage-policy error; the
   * keychain-denied read still resolves to undefined).
   */
  private warnOnce(kind: WarnOnceKind, message: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.warnedOnce.has(kind)) return Effect.void;
      this.warnedOnce.add(kind);
      return Effect.tryPromise({
        try: async () => this.options.showWarningMessage?.(message),
        catch: (cause) => cause,
      }).pipe(
        Effect.tapError((cause) =>
          Effect.sync(() =>
            console.warn(
              `ElectronSecrets: the "${kind}" warning dialog failed: ${toErrorMessage(cause)}`,
            ),
          ),
        ),
        Effect.ignore,
      );
    });
  }
}

/** Test-only: reset latched module-level state so unit tests can re-exercise the path. */
export function __resetKeychainStateForTests(): void {
  warnedAboutKeychainDisabled = false;
}

export function getSecretStorageMode(): SecretStorageMode {
  // Test-harness shim: report unavailable without ever calling safeStorage,
  // which is the path that would otherwise prompt the macOS keychain.
  if (isKeychainDisabled()) return 'unavailable';
  if (!safeStorage.isEncryptionAvailable()) return 'unavailable';
  if (
    process.platform === 'linux' &&
    safeStorage.getSelectedStorageBackend() === 'basic_text'
  ) {
    return 'basic_text';
  }
  return 'encrypted';
}
