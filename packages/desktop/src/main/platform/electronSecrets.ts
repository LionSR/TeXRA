import { safeStorage } from 'electron';

import type { PlatformSecrets } from '@platform/secrets';
import type { JsonStore } from '@platform/defaults/jsonStore';
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
    private readonly options: ElectronSecretsOptions = {},
  ) {}

  /** Environment variables override persisted Electron secrets. */
  async get(key: string): Promise<string | undefined> {
    const envValue = process.env[key];
    if (envValue !== undefined) return envValue;

    return this.getStored(key);
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
    try {
      return safeStorage.decryptString(Buffer.from(stored.value, 'base64'));
    } catch (error) {
      this.keychainDecryptUnavailable = true;
      // The macOS keychain (and Linux libsecret/KWallet) can reject decrypts
      // when the user denies the OS prompt or the entry encryption key has
      // been rotated. Treat this as "no saved secret" so the rest of the
      // app — most importantly the renderer bootstrap — keeps working.
      // Without this swallow, a single decrypt rejection during launch can
      // surface as an unhandled rejection in renderer bootstrap and leave
      // the user staring at a blank white window.
      console.warn(
        `ElectronSecrets: safeStorage.decryptString failed for "${key}"; treating as unset. ` +
          `Cause: ${toErrorMessage(error)}`,
      );
      await this.warnOnce('keychainDenied', KEYCHAIN_DENIED_WARNING_MESSAGE);
      return undefined;
    }
  }

  async set(key: string, value: string): Promise<void> {
    // Test-harness shim: with the env var set, swallow writes instead of
    // throwing on the unavailable storage mode. The harness explicitly opts
    // out of persisted secrets, so a thrown error would break the same
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
        await this.store.set(key, stored);
        return;
      }
      case 'unavailable':
        throw new Error(SAFE_STORAGE_UNAVAILABLE_MESSAGE);
      case 'basic_text':
        await this.warnOnce(
          'basicText',
          LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE,
        );
        throw new Error(LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE);
      default:
        assertNever(storageMode, 'Unhandled Electron secret storage mode');
    }
  }

  async delete(key: string): Promise<void> {
    await this.store.set(key, undefined);
  }

  async listStoredKeys(): Promise<readonly string[]> {
    return Object.keys(this.store.snapshot());
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
  private async warnOnce(kind: WarnOnceKind, message: string): Promise<void> {
    if (this.warnedOnce.has(kind)) return;
    this.warnedOnce.add(kind);
    try {
      await this.options.showWarningMessage?.(message);
    } catch {
      // Dialog failures are swallowed; see method doc comment.
    }
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
