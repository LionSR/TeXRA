import { safeStorage } from 'electron';

import { JsonStore } from './jsonStore.js';
import type { PlatformSecrets } from '@platform/secrets';

type StoredSecret = { encrypted: true; value: string };
type SecretStorageMode = 'encrypted' | 'basic_text' | 'unavailable';

interface ElectronSecretsOptions {
  showWarningMessage?: (message: string) => Promise<void> | void;
}

export const LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE =
  'TeXRA cannot store secrets securely because Electron is using Linux basic_text storage. Set up a system keyring such as GNOME Keyring/libsecret or KWallet, then restart TeXRA. Environment variables still work for API keys.';

export const KEYCHAIN_DENIED_WARNING_MESSAGE =
  'TeXRA could not read its saved secrets because the system keychain prompt was denied. Saved API keys and sign-in sessions will not be available until you allow access. Restart TeXRA after granting access to retry.';

const SAFE_STORAGE_UNAVAILABLE_MESSAGE =
  'Electron safeStorage is unavailable for secret writes.';

function isStoredSecret(value: unknown): value is StoredSecret {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as StoredSecret).value === 'string' &&
    (value as StoredSecret).encrypted === true
  );
}

export class ElectronSecrets implements PlatformSecrets {
  private warnedAboutBasicText = false;
  private warnedAboutKeychainDenied = false;

  constructor(
    private readonly store: JsonStore,
    private readonly options: ElectronSecretsOptions = {},
  ) {}

  /** Environment variables override persisted Electron secrets. */
  async get(key: string): Promise<string | undefined> {
    const envValue = process.env[key];
    if (envValue !== undefined) return envValue;

    const stored = this.store.get<unknown>(key);
    if (!isStoredSecret(stored)) return undefined;
    try {
      return safeStorage.decryptString(Buffer.from(stored.value, 'base64'));
    } catch (error) {
      // The macOS keychain (and Linux libsecret/KWallet) can reject decrypts
      // when the user denies the OS prompt or the entry encryption key has
      // been rotated. Treat this as "no saved secret" so the rest of the
      // app — most importantly the renderer bootstrap — keeps working.
      // Without this swallow, a single decrypt rejection during launch can
      // surface as an unhandled rejection in renderer bootstrap and leave
      // the user staring at a blank white window.
      console.warn(
        `ElectronSecrets: safeStorage.decryptString failed for "${key}"; treating as unset. ` +
          `Cause: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.warnAboutKeychainDenied();
      return undefined;
    }
  }

  async set(key: string, value: string): Promise<void> {
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
        await this.warnAboutBasicTextStorage();
        throw new Error(LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE);
      default:
        assertNever(storageMode);
    }
  }

  async delete(key: string): Promise<void> {
    await this.store.set(key, undefined);
  }

  private async warnAboutBasicTextStorage(): Promise<void> {
    if (this.warnedAboutBasicText) return;
    this.warnedAboutBasicText = true;
    try {
      await this.options.showWarningMessage?.(
        LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE,
      );
    } catch {
      // Secret writes must still reject with the storage-policy error even if
      // the warning dialog itself fails.
    }
  }

  private async warnAboutKeychainDenied(): Promise<void> {
    if (this.warnedAboutKeychainDenied) return;
    this.warnedAboutKeychainDenied = true;
    try {
      await this.options.showWarningMessage?.(KEYCHAIN_DENIED_WARNING_MESSAGE);
    } catch {
      // The keychain-denied warning is best-effort. Suppress dialog errors so
      // the secret read still resolves to undefined and the caller can proceed.
    }
  }
}

/**
 * Force the OS keychain prompt to appear at app launch (before the renderer
 * loads) by performing one harmless `safeStorage.encryptString` call. macOS
 * (and Linux keyring backends) trigger the "@texra/desktop wants to use your
 * confidential information" dialog on the first encrypt/decrypt; running it
 * here turns that into a deterministic startup event instead of a surprise
 * during user interaction. Subsequent calls reuse the unlocked key without
 * prompting.
 *
 * Safe to call multiple times — the first invocation does the work and the
 * rest are no-ops. Returns `true` when the prompt was attempted, `false` when
 * `safeStorage` is unavailable (e.g., Linux without a configured keyring).
 */
let keychainPrewarmed = false;
export async function prewarmElectronKeychain(): Promise<boolean> {
  if (keychainPrewarmed) return true;
  if (!safeStorage.isEncryptionAvailable()) return false;
  try {
    safeStorage.encryptString('texra-keychain-prewarm');
    keychainPrewarmed = true;
    return true;
  } catch (error) {
    // We do NOT mark prewarmed when the OS rejects so a future retry path
    // (e.g., re-running after the user changes keychain permissions) can try
    // again. Swallow so startup keeps progressing — the per-key fallback in
    // ElectronSecrets.get() handles the same denial path.
    console.warn(
      `prewarmElectronKeychain: encryptString failed; continuing without prewarm. ` +
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/** Test-only: reset the prewarm latch so unit tests can re-exercise the path. */
export function __resetKeychainPrewarmedForTests(): void {
  keychainPrewarmed = false;
}

export function getSecretStorageMode(): SecretStorageMode {
  if (!safeStorage.isEncryptionAvailable()) return 'unavailable';
  if (
    process.platform === 'linux' &&
    safeStorage.getSelectedStorageBackend() === 'basic_text'
  ) {
    return 'basic_text';
  }
  return 'encrypted';
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Electron secret storage mode: ${value}`);
}
