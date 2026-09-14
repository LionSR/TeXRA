import { Effect } from 'effect';
import { safeStorage } from 'electron';

import {
  SecretsFailed,
  secretsGet,
  type PlatformSecrets,
  type SecretsOperation,
} from '@platform/secrets';
import type { ProcessRuntime } from '@platform/processRuntime';
import { nodeFileServices, type JsonStore } from '@platform/defaults/jsonStore';
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
    private readonly store: JsonStore,
    /** The process runtime the composition root built; this port's writes run
     *  on it rather than on a looked-up one. */
    private readonly runtime: ProcessRuntime,
    private readonly options: ElectronSecretsOptions = {},
  ) {}

  /** Environment variables override persisted Electron secrets. */
  async get(key: string): Promise<string | undefined> {
    return secretsGet(this, key);
  }

  async getStored(key: string): Promise<string | undefined> {
    // Test-harness shim: skip safeStorage entirely when the env var is set so
    // headless Playwright runs do not block on the macOS keychain prompt.
    // Env-var API key overrides above already returned; here we just report
    // "no saved secret" rather than touching safeStorage.
    if (isKeychainDisabled()) {
      warnKeychainDisabledOnce();
      return undefined;
    }

    if (this.keychainDecryptUnavailable) return undefined;

    const stored = this.store.get<unknown>(key);
    if (!isStoredSecret(stored)) return undefined;
    return this.runtime.runPromise(this.decryptStored(key, stored.value));
  }

  /**
   * Decrypt one stored value, recovering a refused decrypt to "no saved
   * secret". The macOS keychain (and Linux libsecret/KWallet) can reject
   * decrypts when the user denies the OS prompt or the entry encryption key
   * has been rotated. Without this recovery a single decrypt rejection during
   * launch surfaces as an unhandled rejection in renderer bootstrap and
   * leaves the user staring at a blank white window — so it is recovered, but
   * loudly: the cause is logged and the user is warned once.
   */
  private decryptStored(
    key: string,
    encrypted: string,
  ): Effect.Effect<string | undefined> {
    return Effect.try({
      try: () => safeStorage.decryptString(Buffer.from(encrypted, 'base64')),
      catch: (cause) =>
        new SecretsFailed({
          reason: 'decrypt-failed',
          operation: 'getStored',
          key,
          message: `The system keychain refused to decrypt the stored secret "${key}": ${toErrorMessage(cause)}`,
          cause,
        }),
    }).pipe(
      Effect.catch((failure) =>
        Effect.as(
          Effect.andThen(
            Effect.sync(() => {
              this.keychainDecryptUnavailable = true;
              console.warn(
                `ElectronSecrets: safeStorage.decryptString failed for "${key}"; treating as unset. ` +
                  `Cause: ${toErrorMessage(failure.cause)}`,
              );
            }),
            this.warnOnce('keychainDenied', KEYCHAIN_DENIED_WARNING_MESSAGE),
          ),
          undefined,
        ),
      ),
    );
  }

  /**
   * Encrypt and commit one secret. Host-controller study Q2 rules that a
   * credential commit survives cancellation, so the encrypt-and-write region
   * is uninterruptible: a cancelled caller either never started the commit or
   * observes a finished one.
   */
  set(key: string, value: string): Effect.Effect<void, SecretsFailed> {
    return Effect.suspend(() => {
      // Test-harness shim: with the env var set, swallow writes instead of
      // failing on the unavailable storage mode. The harness explicitly opts
      // out of persisted secrets, so a failure would break the same
      // bootstrap path we are trying to keep alive.
      if (isKeychainDisabled()) {
        warnKeychainDisabledOnce();
        return Effect.void;
      }
      const storageMode = getSecretStorageMode();
      switch (storageMode) {
        case 'encrypted':
          return Effect.uninterruptible(
            this.commit(key, {
              encrypted: true,
              value: safeStorage.encryptString(value).toString('base64'),
            }),
          );
        case 'unavailable':
          return Effect.fail(
            this.unavailable(key, SAFE_STORAGE_UNAVAILABLE_MESSAGE),
          );
        case 'basic_text':
          return Effect.andThen(
            this.warnOnce('basicText', LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE),
            Effect.fail(
              this.unavailable(key, LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE),
            ),
          );
        default:
          assertNever(storageMode, 'Unhandled Electron secret storage mode');
      }
    });
  }

  /** The commit region of a removal, uninterruptible for the same reason. */
  delete(key: string): Effect.Effect<void, SecretsFailed> {
    return Effect.uninterruptible(this.commit(key, undefined));
  }

  listStoredKeys(): Effect.Effect<readonly string[], SecretsFailed> {
    return Effect.sync(() => this.store.keys());
  }

  getEnv(name: string): string | undefined {
    return process.env[name];
  }

  /**
   * Shows a dialog once per kind per instance. Best-effort: a failed dialog
   * must not affect the outcome of the secret operation that triggered it
   * (the basic_text write still rejects with the storage-policy error; the
   * keychain-denied read still resolves to undefined).
   */
  private warnOnce(kind: WarnOnceKind, message: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.warnedOnce.has(kind)) return Effect.void;
      this.warnedOnce.add(kind);
      return Effect.ignore(
        Effect.tryPromise(async () =>
          this.options.showWarningMessage?.(message),
        ),
      );
    });
  }

  /** Persist (or clear) one entry of the desktop secrets store. */
  private commit(
    key: string,
    stored: StoredSecret | undefined,
  ): Effect.Effect<void, SecretsFailed> {
    const operation: SecretsOperation = stored ? 'set' : 'delete';
    return Effect.mapError(
      Effect.provide(this.store.set(key, stored), nodeFileServices),
      (cause) =>
        new SecretsFailed({
          reason: 'io',
          operation,
          key,
          message: `Could not ${operation === 'set' ? 'store' : 'remove'} the desktop secret "${key}": ${toErrorMessage(cause)}`,
          cause,
        }),
    );
  }

  /** The host has no secure store to write to; nothing was written. */
  private unavailable(key: string, message: string): SecretsFailed {
    return new SecretsFailed({
      reason: 'store-unavailable',
      operation: 'set',
      key,
      message,
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
