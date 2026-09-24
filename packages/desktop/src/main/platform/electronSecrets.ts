import { Effect } from 'effect';
import { safeStorage } from 'electron';

import { emitAppSignal } from '@eventBus/AppSignals';
import type { MessageHost } from '@hosts/uiHosts';
import { invalidateApiKeyCache } from '@model/apiProviders';
import {
  SecretsFailed,
  secretsGet,
  type PlatformSecrets,
  type SecretsOperation,
} from '@platform/secrets';
import type { JsonStore } from '@platform/defaults/jsonStore';
import { assertNever } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { isEnvFlagEnabled } from '@utils/system/envFlags';

type StoredSecret = { encrypted: true; value: string };
type SecretStorageMode = 'encrypted' | 'basic_text' | 'unavailable';

interface ElectronSecretsOptions {
  showWarningMessage?: MessageHost['showWarningMessage'];
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
    private readonly options: ElectronSecretsOptions = {},
  ) {}

  /** Environment variables override persisted Electron secrets. */
  get(key: string) {
    return secretsGet(this, key);
  }

  getStored(key: string): Effect.Effect<string | undefined, SecretsFailed> {
    return Effect.suspend(() => {
      // Test-harness shim: skip safeStorage entirely when the env var is set
      // so headless Playwright runs do not block on the macOS keychain
      // prompt. Env-var API key overrides already returned; here we just
      // report "no saved secret" rather than touching safeStorage.
      if (isKeychainDisabled()) {
        warnKeychainDisabledOnce();
        return Effect.succeed(undefined);
      }

      if (this.keychainDecryptUnavailable) return Effect.succeed(undefined);

      const stored = this.store.get<unknown>(key);
      if (!isStoredSecret(stored)) return Effect.succeed(undefined);
      return this.decryptStored(key, stored.value);
    });
  }

  /**
   * Decrypt one stored value, recovering a refused decrypt to "no saved
   * secret". The macOS keychain (and Linux libsecret/KWallet) can reject
   * decrypts when the user denies the OS prompt or the entry encryption key
   * has been rotated. Without this recovery a single decrypt rejection during
   * launch surfaces as an unhandled rejection in renderer bootstrap and
   * leaves the user staring at a blank white window — so it is recovered, but
   * loudly: the cause is logged and the user is warned once. This is the
   * `decrypt-failed` rule the port documents: the reason is constructed here
   * to be reported, and never reaches the caller's error channel, because
   * every reader of a credential wants the same "no saved secret" answer.
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
      // The handler's parameter is the whole error type this expression can
      // carry, so a second failure added to this channel (another `mapError`,
      // a joined step) fails to compile instead of being reported as a refused
      // decrypt and answered with "no saved secret".
      Effect.catch((failure: SecretsFailed) =>
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
   * Encrypt and commit one secret. `safeStorage.encryptString` throws rather
   * than returns when the keychain refuses the key despite the availability
   * probe above, so it is a step of the program with its own typed failure,
   * not a synchronous call in the middle of building one — a throw there is a
   * failed write, not a defect.
   *
   * Host-controller study Q2 rules that a credential commit survives
   * cancellation. That region is the commit alone, and {@link JsonStore.set}
   * owns it: the mask starts once the write lane is entered, so a write still
   * queued behind another can be cancelled. Encryption stays outside it and
   * interruptible on purpose — it is one synchronous step with nothing to
   * leave half-done, and a fiber interrupted between it and the commit has
   * written nothing.
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
          return Effect.flatMap(
            Effect.try({
              try: () => safeStorage.encryptString(value).toString('base64'),
              catch: (cause) =>
                new SecretsFailed({
                  reason: 'io',
                  operation: 'set',
                  key,
                  message: `The system keychain refused to encrypt the secret "${key}": ${toErrorMessage(cause)}`,
                  cause,
                }),
            }),
            (encrypted) =>
              this.commit(key, { encrypted: true, value: encrypted }),
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

  /** A removal is the commit alone, masked where every commit is. */
  delete(key: string): Effect.Effect<void, SecretsFailed> {
    return this.commit(key, undefined);
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
      return (this.options.showWarningMessage?.(message) ?? Effect.void).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `Keychain warning could not be shown: ${message}`,
            error,
          ),
        ),
      );
    });
  }

  /**
   * Persist (or clear) one entry of the desktop secrets store. The store's
   * own write carries the Q2 mask: the lane wait is interruptible, the
   * read-modify-write behind it is not. The key cache drop and the
   * `credentialChanged` signal run on every exit, because a commit that
   * landed still exits as interrupted when its caller was cancelled.
   */
  private commit(
    key: string,
    stored: StoredSecret | undefined,
  ): Effect.Effect<void, SecretsFailed> {
    const operation: SecretsOperation = stored ? 'set' : 'delete';
    return Effect.mapError(
      this.store.set(key, stored),
      (cause) =>
        new SecretsFailed({
          reason: 'io',
          operation,
          key,
          message: `Could not ${operation === 'set' ? 'store' : 'remove'} the desktop secret "${key}": ${toErrorMessage(cause)}`,
          cause,
        }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          invalidateApiKeyCache();
          emitAppSignal('credentialChanged', { key });
        }),
      ),
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
