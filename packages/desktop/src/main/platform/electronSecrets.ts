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
    return safeStorage.decryptString(Buffer.from(stored.value, 'base64'));
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
